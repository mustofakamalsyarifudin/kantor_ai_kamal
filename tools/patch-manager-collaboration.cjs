#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const paths = {
  server: path.join(root, 'apps', 'api', 'src', 'server.ts'),
  app: path.join(root, 'apps', 'web', 'src', 'App.tsx'),
  api: path.join(root, 'apps', 'web', 'src', 'lib', 'api.ts'),
  route: path.join(root, 'tools', 'manager-review-route.snippet.txt')
};
function fail(message) { console.error(`[M4.1] ${message}`); process.exit(1); }
for (const [key, file] of Object.entries(paths)) if (!fs.existsSync(file)) fail(`File ${key} tidak ditemukan: ${file}`);
let server = fs.readFileSync(paths.server, 'utf8');
let app = fs.readFileSync(paths.app, 'utf8');
let api = fs.readFileSync(paths.api, 'utf8');
const route = fs.readFileSync(paths.route, 'utf8').trim();
if (!server.includes('app.post') || !server.includes('/api/manager/launch') || !server.includes('artifactRoot') || !server.includes('safeProviderError')) fail('server.ts tidak cocok dengan fondasi M4. File tidak diubah.');
server = server.replace(
  "Rancang pekerjaan agar dapat dijalankan secara paralel jika memungkinkan; sistem belum menjamin urutan/dependensi antar-subtugas.",
  "Letakkan riset/analisis yang menjadi sumber konteks sebagai subtugas pertama bila relevan. Subtugas pertama harus diselesaikan dan disetujui manusia sebelum subtugas berikutnya diantrekan; artefaknya akan diteruskan otomatis sebagai konteks. Subtugas setelah tahap pertama dapat berjalan paralel."
);
// M4.1 dependency rule: queue sequence 1 first; release remaining children only after its result is approved.
if (!server.includes("manager.context_handoff_received")) {
  const queueLoop = /const queuedChildren\s*=\s*\[\];\s*for\s*\(const child of created\.children\)\s*\{\s*const queued = await queueTaskRecord\(child\.id,\s*workspaceId,\s*request\.user\.sub,\s*\[TaskStatus\.DRAFT\]\);\s*queuedChildren\.push\(queued\);\s*\}/s;
  if (!queueLoop.test(server)) fail('Loop antrean subtugas M4 tidak dikenali. File tidak diubah.');
  server = server.replace(queueLoop, `const queuedChildren = [];
  const firstChild = created.children[0];
  if (firstChild) {
    const queued = await queueTaskRecord(firstChild.id, workspaceId, request.user.sub, [TaskStatus.DRAFT]);
    queuedChildren.push(queued);
  }
  const deferredChildCount = created.children.length - queuedChildren.length;`);
  server = server.replace(/childCount:\s*queuedChildren\.length/, 'childCount: created.children.length, queuedCount: queuedChildren.length, deferredChildCount');
  const responseAnchor = /return reply\.code\(201\)\.send\(\{\s*parent,\s*subtasks,\s*queueWarning:/s;
  if (!responseAnchor.test(server)) fail('Objek respons peluncuran tidak dikenali. File tidak diubah.');
  server = server.replace(responseAnchor, 'return reply.code(201).send({ parent, subtasks, queuedCount: queuedChildren.length, deferredCount: deferredChildCount, queueWarning:');
}
const statusCompletion = /emitWorkspace\(\s*workspaceId,\s*"task\.status_changed",\s*updated\s*\);\s*return updated;/s;
if (!server.includes('const followup = await releaseManagerFollowups')) {
  if (!statusCompletion.test(server)) fail('Titik respons persetujuan tugas tidak dikenali. File tidak diubah.');
  server = server.replace(statusCompletion, `let followupWarning: string | null = null;
  let followupNotice: string | null = null;
  if (task.parentTaskId && status === TaskStatus.COMPLETED) {
    try {
      const followup = await releaseManagerFollowups(task.id, workspaceId, request.user.sub);
      followupWarning = followup.warning;
      if (followup.queuedCount > 0) followupNotice = \`Hasil tahap pertama disetujui; \${followup.queuedCount} subtugas lanjutan masuk antrean dengan konteks artefak sumber.\`;
    } catch (error) {
      request.log.warn({ err: error, taskId: task.id }, "Subtugas lanjutan Manager AI tidak dapat dilepas");
      followupWarning = "Subtugas telah disetujui, tetapi antrean tahap berikutnya gagal. Periksa Redis/worker sebelum mencoba ulang.";
    }
  }
  emitWorkspace(workspaceId, "task.status_changed", updated);
  return followupWarning || followupNotice
    ? reply.send({ ...updated, ...(followupWarning ? { queueWarning: followupWarning } : {}), ...(followupNotice ? { queueNotice: followupNotice } : {}) })
    : updated;`);
}
if (!app.includes('/api/manager/plan') || !app.includes('/api/manager/launch') || !app.includes('managerLaunchLoading') || !app.includes('ManagerLaunchResult')) fail('App.tsx tidak cocok dengan UI Manager AI M4. File tidak diubah.');
if (!api.includes('ManagerLaunchResult') || !api.includes('TaskArtifact')) fail('api.ts tidak cocok dengan tipe Manager AI M4. File tidak diubah.');
if (!/setNotice\(updated\.queueNotice \|\| updated\.queueWarning/.test(app)) {
  app = app.replace(/setNotice\(`Status tugas diperbarui: \${statusTitles\[status\] \|\| status}\.`\);/, 'setNotice(updated.queueNotice || updated.queueWarning || `Status tugas diperbarui: ${statusTitles[status] || status}.`);');
}
const childBadge = '    {task.parentTaskId && <div className="manager-child-badge">Subtugas delegasi Nara</div>}';
if (app.includes(childBadge) && !app.includes('Konteks hasil tahap sebelumnya sudah diteruskan.')) {
  app = app.replace(childBadge, childBadge + '\n    {task.metadata?.managerPlanChild === true && Number(task.metadata?.sequence || 0) > 1 && task.status === "DRAFT" && !task.metadata?.contextInjectedFromTaskId && <div className="diagnostic-callout"><Activity size={14}/><span>Menunggu subtugas pertama disetujui. Hasil analisis akan diteruskan sebagai konteks sebelum tugas ini masuk antrean.</span></div>}\n    {task.metadata?.managerPlanChild === true && typeof task.metadata?.contextInjectedFromTaskId === "string" && <div className="manager-plan-badge"><Check size={12}/><span>Konteks hasil tahap sebelumnya sudah diteruskan.</span></div>}');
}

if (!server.includes('"/api/manager/review"') && !server.includes("'/api/manager/review'")) {
  const anchor = /app\.get\(\s*["']\/api\/queue\/status["']/m;
  const match = server.match(anchor);
  if (!match || match.index === undefined) fail('Titik penyisipan endpoint /api/queue/status tidak ditemukan. Tidak ada file yang diubah.');
  server = server.slice(0, match.index) + route + '\n' + server.slice(match.index);
}

if (!api.includes('queueNotice?: string')) {
  api = api.replace('queueWarning?: string;', 'queueWarning?: string; queueNotice?: string;');
}
if (!/type ManagerReviewResult\s*=/.test(api)) {
  const apiAnchor = /export type ManagerLaunchResult\s*=\s*\{[^\n]*\};/m;
  const apiMatch = api.match(apiAnchor);
  if (!apiMatch || apiMatch.index === undefined) fail('Tipe ManagerLaunchResult tidak ditemukan di api.ts. Tidak ada file yang diubah.');
  const typeText = '\nexport type ManagerReviewSource = { taskId: string; title: string; agentName: string; agentRole?: string; artifactId: string; artifactName: string };\nexport type ManagerReviewResult = { parentTaskId: string; parentStatus?: string; reviewStatus?: string; readyForReview?: boolean; alreadyExists?: boolean; artifact: TaskArtifact | null; sources?: ManagerReviewSource[]; usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } | null; message?: string };';
  const end = apiMatch.index + apiMatch[0].length;
  api = api.slice(0, end) + typeText + api.slice(end);
}

if (/export type ManagerLaunchResult = \{ parent: Task; subtasks: Task\[\]; queueWarning\?: string \| null \};/.test(api) && !api.includes('queuedCount?: number')) {
  api = api.replace(/export type ManagerLaunchResult = \{ parent: Task; subtasks: Task\[\]; queueWarning\?: string \| null \};/, 'export type ManagerLaunchResult = { parent: Task; subtasks: Task[]; queueWarning?: string | null; queuedCount?: number; deferredCount?: number };');
}
  const noticePattern = /setNotice\((?:result\.queueWarning \|\| )?`[^`]*subtugas dibuat[^`]*`\);/;
  if (noticePattern.test(app)) {
    app = app.replace(noticePattern, 'setNotice(result.queueWarning || `Rencana diluncurkan. ${result.subtasks.length} subtugas dibuat; ${result.queuedCount ?? 1} subtugas pertama masuk antrean. Subtugas berikutnya menunggu hasil tahap pertama disetujui dan akan menerima artefaknya sebagai konteks.`);');
  }
if (!app.includes('type ManagerReviewResult')) {
  app = app.replace(/type ManagerLaunchResult\s*}/, 'type ManagerLaunchResult, type ManagerReviewResult }');
}
if (!app.includes('managerReviewLoadingId')) {
  const stateAnchor = /const \[managerLaunchLoading, setManagerLaunchLoading\] = useState\(false\);/;
  if (!stateAnchor.test(app)) fail('State managerLaunchLoading tidak ditemukan di App.tsx. Tidak ada file yang diubah.');
  app = app.replace(stateAnchor, '$&\n  const [managerReviewLoadingId, setManagerReviewLoadingId] = useState<string | null>(null);\n  const [managerReviewResults, setManagerReviewResults] = useState<Record<string, ManagerReviewResult>>({});');
}
if (!app.includes('function moveManagerPlanTask')) {
  const launchFunctionAnchor = /  async function launchManagerPlan\(\) \{/;
  const launchMatch = app.match(launchFunctionAnchor);
  if (!launchMatch || launchMatch.index === undefined) fail('Fungsi launchManagerPlan tidak ditemukan. File tidak diubah.');
  const moveFunction = `  function moveManagerPlanTask(index: number, delta: -1 | 1) {
    setManagerPlan(current => {
      if (!current) return current;
      const target = index + delta;
      if (target < 0 || target >= current.tasks.length) return current;
      const reordered = [...current.tasks];
      const sourceTask = reordered[index];
      const targetTask = reordered[target];
      if (!sourceTask || !targetTask) return current;
      reordered[index] = targetTask;
      reordered[target] = sourceTask;
      return { ...current, tasks: reordered };
    });
  }
`;
  app = app.slice(0, launchMatch.index) + moveFunction + app.slice(launchMatch.index);
}
const oldPlanHeader = '<div className="manager-plan-task-top"><span className="manager-task-index">SUBTUGAS {String(index + 1).padStart(2,"0")}</span><span className={`priority-pill priority-${item.priority.toLowerCase()}`}>{priorityTitles[item.priority] || item.priority}</span></div>';
if (app.includes(oldPlanHeader) && !app.includes('aria-label="Naikkan subtugas"')) {
  app = app.replace(oldPlanHeader, '<div className="manager-plan-task-top"><span className="manager-task-index">SUBTUGAS {String(index + 1).padStart(2,"0")}</span><div style={{display:"flex",alignItems:"center",gap:6}}><span className={`priority-pill priority-${item.priority.toLowerCase()}`}>{priorityTitles[item.priority] || item.priority}</span><button type="button" className="button-secondary" style={{padding:"4px 8px"}} disabled={index===0} aria-label="Naikkan subtugas" onClick={() => moveManagerPlanTask(index,-1)}>↑</button><button type="button" className="button-secondary" style={{padding:"4px 8px"}} disabled={index===managerPlan.tasks.length-1} aria-label="Turunkan subtugas" onClick={() => moveManagerPlanTask(index,1)}>↓</button></div></div>');
}
app = app.replace('Periksa instruksi, alasan pembagian, dan agent penanggung jawab. Anda dapat mengedit judul, instruksi, prioritas, atau penugasan sebelum meluncurkan.', 'Periksa instruksi, alasan pembagian, dan agent penanggung jawab. Urutkan riset/analisis sebagai subtugas pertama bila hasilnya dibutuhkan oleh tugas lain. Anda dapat mengedit judul, instruksi, prioritas, penugasan, dan urutan sebelum meluncurkan.');
app = app.replace('Tindakan ini membuat satu rencana induk dan langsung mengantrekan seluruh subtugas. Setiap subtugas yang menggunakan OpenAI dapat memakai kredit API. Hasilnya tetap harus Anda review.', 'Peluncuran membuat satu rencana induk dan mengantrekan subtugas pertama saja. Setelah hasil tahap pertama Anda setujui, artefaknya diteruskan ke subtugas berikutnya sebelum subtugas itu masuk antrean. Setiap subtugas dapat menggunakan kredit OpenAI dan hasilnya tetap harus Anda review.');
if (!app.includes('async function generateManagerFinalReview')) {
  const functionAnchor = /  async function toggleTaskRuns\(taskId: string\) \{/;
  const match = app.match(functionAnchor);
  if (!match || match.index === undefined) fail('Fungsi toggleTaskRuns tidak ditemukan di App.tsx. Tidak ada file yang diubah.');
  const functions = `  async function loadManagerFinalReview(parentTaskId: string) {
    try {
      const result = await api<ManagerReviewResult>(\`/api/manager/review/\${parentTaskId}\`);
      setManagerReviewResults(previous => ({ ...previous, [parentTaskId]: result }));
      if (!result.artifact) setNotice(result.message || "Paket final belum tersedia.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Status review final tidak dapat dimuat.");
    }
  }
  async function generateManagerFinalReview(parentTaskId: string) {
    const confirmed = window.confirm("Nara akan membaca artefak seluruh subtugas yang sudah disetujui selesai, lalu menyusun dokumen paket final. Ini memanggil OpenAI dan dapat menggunakan kredit API. Tidak ada publikasi yang dilakukan. Lanjutkan?");
    if (!confirmed) return;
    setManagerReviewLoadingId(parentTaskId); setError(""); setNotice("");
    try {
      const result = await api<ManagerReviewResult>("/api/manager/review", {
        method: "POST", body: JSON.stringify({ parentTaskId })
      });
      setManagerReviewResults(previous => ({ ...previous, [parentTaskId]: result }));
      setNotice(result.message || "Review final Nara tersimpan.");
      await refreshOperationalData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Nara gagal menyusun review final.");
    } finally { setManagerReviewLoadingId(null); }
  }
`;
  app = app.slice(0, match.index) + functions + app.slice(match.index);
}
if (!app.includes('manager-final-review-panel')) {
  const uiAnchor = '      {view === "team" && <>';
  if (!app.includes(uiAnchor)) fail('Lokasi penyisipan panel Manager AI tidak ditemukan. Tidak ada file yang diubah.');
  const panel = `      {view === "manager" && <section className="panel manager-final-review-panel" style={{marginTop:18}}>
        <div className="panel-heading"><div><h2>Kolaborasi & review final</h2><p>Nara membaca artefak spesialis setelah setiap subtugas selesai dan disetujui. Tombol ini membuat satu dokumen sintesis tersimpan; tidak melakukan publikasi.</p></div><span className="manager-step-pill">03 · SINTESIS</span></div>
        <div className="manager-composer-body">
          {tasks.filter(task => task.metadata?.managerPlan === true).map(parent => {
            const children = tasks.filter(task => task.parentTaskId === parent.id);
            const allChildrenApproved = children.length >= 2 && children.every(task => task.status === "COMPLETED");
            const savedArtifactId = typeof parent.metadata?.managerReviewArtifactId === "string" ? parent.metadata.managerReviewArtifactId : "";
            const review = managerReviewResults[parent.id];
            const ready = parent.status === "REVIEW_REQUIRED" && allChildrenApproved;
            return <article key={parent.id} className="manager-plan-task" style={{marginBottom:12}}>
              <div className="manager-plan-task-top"><b>{parent.title}</b><span className={statusClass(parent.status)}>{statusTitles[parent.status] || parent.status}</span></div>
              <p style={{fontSize:12,color:"var(--muted)",margin:"8px 0"}}>{children.length} subtugas · {children.filter(task => task.status === "COMPLETED").length} disetujui selesai · review Nara: {String(parent.metadata?.managerReviewStatus || "belum dibuat")}</p>
              {!savedArtifactId && !ready && <div className="manager-cost-note">Selesaikan dan setujui seluruh subtugas pada Papan Tugas terlebih dahulu. Nara belum akan menyintesis hasil jika ada subtugas yang belum disetujui selesai.</div>}
              {!savedArtifactId && ready && <button className="button-primary" disabled={managerReviewLoadingId === parent.id || managerReviewLoadingId !== null} onClick={() => void generateManagerFinalReview(parent.id)}>{managerReviewLoadingId === parent.id ? <LoaderCircle size={15} className="spin"/> : <WandSparkles size={15}/>} Susun paket final dengan Nara</button>}
              {savedArtifactId && !review?.artifact && <button className="button-secondary" onClick={() => void loadManagerFinalReview(parent.id)}>Muat review final tersimpan</button>}
              {review?.artifact && <div className="manager-rationale" style={{marginTop:10}}><b>Review final tersedia: {review.artifact.name}</b><span>{review.message || "Artefak sintesis Nara tersimpan di tugas induk."}</span><button className="button-secondary" style={{alignSelf:"flex-start",marginTop:8}} onClick={() => void downloadArtifact(review.artifact!)}><Download size={14}/> Unduh paket final</button></div>}
            </article>;
          })}
          {!tasks.some(task => task.metadata?.managerPlan === true) && <div className="empty-state"><div><WandSparkles size={20}/></div><p>Belum ada rencana induk. Jalankan satu rencana Nara agar panel ini dapat mengumpulkan hasil subtugas.</p></div>}
        </div>
      </section>}
`;
  app = app.replace(uiAnchor, panel + uiAnchor);
}

const changed = [
  [paths.server, server], [paths.api, api], [paths.app, app]
];
for (const [file, content] of changed) {
  const before = fs.readFileSync(file, 'utf8');
  if (before === content) continue;
  const backup = `${file}.m41-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(file, backup);
}
for (const [file, content] of changed) fs.writeFileSync(file, content, 'utf8');
console.log('[M4.1] Kolaborasi dan final review berhasil dipasang. Backup .m41-backup-* dibuat untuk file yang berubah.');
console.log('[M4.1] Langkah berikutnya: jalankan npm.cmd run build, lalu restart API/worker/web.');
