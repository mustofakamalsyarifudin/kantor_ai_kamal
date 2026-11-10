const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'apps', 'api', 'src', 'server.ts');
if (!fs.existsSync(serverPath)) {
  console.error('File tidak ditemukan:', serverPath);
  process.exit(1);
}
let source = fs.readFileSync(serverPath, 'utf8');

const schemaOld = `const managerLaunchSchema = z.object({
  goal: z.string().trim().min(10).max(5000),
  plan: managerPlanSchema,
});`;
const schemaNew = `const managerLaunchSchema = z.object({
  goal: z.string().trim().min(10).max(5000),
  plan: managerPlanSchema,
  launchKey: z.string().trim().min(16).max(100),
});`;

const alreadySchema = source.includes('launchKey: z.string().trim().min(16).max(100)');
const alreadyMetadata = source.includes('launchKey: body.launchKey,');
const alreadyReplay = source.includes('idempotentReplay: true');
if (alreadySchema && alreadyMetadata && alreadyReplay) {
  console.log('Patch idempotensi M4 sudah terpasang; tidak ada perubahan.');
  process.exit(0);
}
if (!alreadySchema && source.split(schemaOld).length !== 2) {
  console.error('Pola managerLaunchSchema tidak cocok. File tidak diubah.');
  process.exit(2);
}
if (!alreadyMetadata && source.split('            managerPlanStatus: "RUNNING",').length !== 2) {
  console.error('Pola metadata tugas induk tidak cocok. File tidak diubah.');
  process.exit(3);
}
const routeMarker = '"/api/manager/launch"';
const routeIndex = source.indexOf(routeMarker);
if (routeIndex < 0) {
  console.error('Endpoint POST /api/manager/launch tidak ditemukan. File tidak diubah.');
  process.exit(4);
}
const requestedMarker = '    const requestedAgentIds = [';
const requestedIndex = source.indexOf(requestedMarker, routeIndex);
if (!alreadyReplay && requestedIndex < 0) {
  console.error('Titik penyisipan pemeriksaan duplikasi tidak ditemukan secara unik. File tidak diubah.');
  process.exit(5);
}

let updated = source;
if (!alreadySchema) updated = updated.replace(schemaOld, schemaNew);
if (!alreadyMetadata) {
  updated = updated.replace(
    '            managerPlanStatus: "RUNNING",',
    '            launchKey: body.launchKey,\n            managerPlanStatus: "RUNNING",'
  );
}
if (!alreadyReplay) {
  const launchRouteIndex = updated.indexOf(routeMarker);
  const insertAt = updated.indexOf(requestedMarker, launchRouteIndex);
  if (insertAt < 0) {
    console.error('Titik penyisipan hilang setelah perubahan. File tidak diubah.');
    process.exit(6);
  }
  const replayBlock = `    // Idempotensi: permintaan ulang dengan launchKey sama menggunakan tugas yang sudah ada.
    const priorManagerParents = await prisma.task.findMany({
      where: { workspaceId, parentTaskId: null, assignedAgentId: manager.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        assignedAgent: { select: { id: true, name: true, role: true, state: true } },
        _count: { select: { subtasks: true, runs: true, artifacts: true } },
      },
    });
    const priorLaunch = priorManagerParents.find((task) => {
      const metadata =
        task.metadata && typeof task.metadata === "object" && !Array.isArray(task.metadata)
          ? (task.metadata as Record<string, unknown>)
          : {};
      return metadata.managerPlan === true && metadata.launchKey === body.launchKey;
    });
    if (priorLaunch) {
      const previousSubtasks = await prisma.task.findMany({
        where: { workspaceId, parentTaskId: priorLaunch.id },
        include: {
          assignedAgent: { select: { id: true, name: true, role: true, state: true } },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      // Jika peluncuran sebelumnya terhenti di tengah proses, coba antrekan hanya subtugas yang belum berjalan.
      for (const child of previousSubtasks) {
        if (child.status === TaskStatus.DRAFT || child.status === TaskStatus.BLOCKED) {
          try {
            await queueTaskRecord(child.id, workspaceId, request.user.sub, [child.status]);
          } catch (error) {
            request.log.warn({ err: error, taskId: child.id }, "Retry antrean subtugas pada peluncuran berulang gagal");
          }
        }
      }
      await syncManagerPlanParentStatus(priorLaunch.id, workspaceId).catch((error) =>
        request.log.warn({ err: error, taskId: priorLaunch.id }, "Status rencana induk tidak dapat disinkronkan pada retry"),
      );
      const replayParent = await prisma.task.findFirst({
        where: { id: priorLaunch.id, workspaceId },
        include: {
          assignedAgent: { select: { id: true, name: true, role: true, state: true } },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
      });
      const replaySubtasks = await prisma.task.findMany({
        where: { workspaceId, parentTaskId: priorLaunch.id },
        include: {
          assignedAgent: { select: { id: true, name: true, role: true, state: true } },
          _count: { select: { subtasks: true, runs: true, artifacts: true } },
        },
        orderBy: { createdAt: "asc" },
      });
      return reply.code(200).send({
        parent: replayParent || priorLaunch,
        subtasks: replaySubtasks,
        queueWarning: replaySubtasks.some((task) => task.status === TaskStatus.BLOCKED || task.status === TaskStatus.DRAFT)
          ? "Peluncuran ini sudah tercatat; sebagian subtugas masih Draft/Terhambat. Periksa Redis dan worker."
          : null,
        idempotentReplay: true,
      });
    }
`;
  updated = updated.slice(0, insertAt) + replayBlock + updated.slice(insertAt);
}

// Check all expected changes before writing so a partial patch never hits disk.
if (!updated.includes('launchKey: z.string().trim().min(16).max(100)') ||
    !updated.includes('launchKey: body.launchKey,') ||
    !updated.includes('idempotentReplay: true')) {
  console.error('Verifikasi patch gagal. File tidak diubah.');
  process.exit(7);
}
const backupDir = path.join(root, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `server.ts.pre-m4-idempotency-${stamp}.bak`);
fs.copyFileSync(serverPath, backupPath);
fs.writeFileSync(serverPath, updated, 'utf8');
console.log('Patch idempotensi M4 berhasil dipasang.');
console.log('Backup:', backupPath);
console.log('Perubahan: launchKey divalidasi, disimpan pada metadata tugas induk, dan permintaan ulang menggunakan tugas yang sudah ada.');
