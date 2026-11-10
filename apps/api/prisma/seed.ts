import "dotenv/config";
import path from "node:path";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: path.resolve(process.cwd(), "../../.env") });

const prisma = new PrismaClient();

const departments = [
  { code: "strategy", name: "Manajemen & Operasional", description: "Perencanaan, delegasi, dan koordinasi", sortOrder: 1 },
  { code: "creative", name: "Video & Konten Kreatif", description: "Video, copywriting, dan konten visual", sortOrder: 2 },
  { code: "analytics", name: "Data & Analitik", description: "Analisis data, insight, dan laporan", sortOrder: 3 },
  { code: "finance", name: "Keuangan & Akuntansi", description: "Anggaran, pembukuan, dan rekonsiliasi awal", sortOrder: 4 },
  { code: "engineering", name: "Programming / Software Engineering", description: "Pemrograman, debugging, dan pengujian dalam sandbox", sortOrder: 5 },
  { code: "research", name: "Riset & Quality Assurance", description: "Riset sumber, verifikasi, dan quality assurance", sortOrder: 6 },
  { code: "design", name: "UI/UX & Product Design", description: "Desain produk digital dan pengalaman pengguna", sortOrder: 7 },
  { code: "support", name: "Customer Support", description: "Dokumentasi dan dukungan pengguna", sortOrder: 8 },
  { code: "meeting", name: "Koordinasi & Project Management", description: "Rapat dan koordinasi pekerjaan lintas fungsi", sortOrder: 9 },
  { code: "pantry", name: "Pantry & Break", description: "Zona istirahat visual, bukan departemen operasional", sortOrder: 10 },
  { code: "lounge", name: "Collaboration Lounge", description: "Kolaborasi dan brainstorming", sortOrder: 11 },
  { code: "focus", name: "Focus Pods", description: "Zona kerja fokus", sortOrder: 12 }
];

const agents = [
  {
    slug: "nara", name: "Nara", role: "AI Operations Manager", departmentCode: "strategy",
    description: "Mengurai tujuan, membuat rencana, mendelegasikan pekerjaan, dan menggabungkan hasil.",
    systemPrompt: "Anda adalah Operations Manager. Buat rencana yang dapat diverifikasi, delegasikan hanya kepada spesialis yang sesuai, jangan mengklaim pekerjaan selesai tanpa output yang tercatat, dan minta persetujuan untuk tindakan eksternal atau berisiko.",
    allowedTools: ["task.read", "task.create", "task.assign", "task.summarize"],
    visualConfig: { shirt: "#c17c68", hair: "#3c302c", skin: "#dba984", pants: "#46566a", hairstyle: "long" }
  },
  {
    slug: "bima", name: "Bima", role: "Data & Business Analyst", departmentCode: "analytics",
    description: "Menganalisis data, memeriksa konsistensi angka, dan menghasilkan rekomendasi berbasis sumber.",
    systemPrompt: "Anda adalah analis data. Nyatakan sumber, asumsi, serta keterbatasan; jangan mengarang angka atau menyimpulkan di luar data.",
    allowedTools: ["file.read", "spreadsheet.read", "calculator", "artifact.create"],
    visualConfig: { shirt: "#6488bc", hair: "#42332f", skin: "#c68c68", pants: "#3f5066", hairstyle: "short" }
  },
  {
    slug: "sinta", name: "Sinta", role: "Finance & Accounting AI", departmentCode: "finance",
    description: "Membantu rekap transaksi, klasifikasi biaya, dan penyusunan anggaran untuk direview.",
    systemPrompt: "Anda membantu analisis keuangan. Perlihatkan perhitungan, jangan melakukan pembayaran atau pencatatan final, dan minta review manusia untuk keputusan keuangan.",
    allowedTools: ["file.read", "spreadsheet.read", "calculator", "artifact.create"],
    visualConfig: { shirt: "#d5a34d", hair: "#292d31", skin: "#e6b892", pants: "#5a6370", hairstyle: "long" }
  },
  {
    slug: "dika", name: "Dika", role: "Video Producer AI", departmentCode: "creative",
    description: "Menyusun konsep video, naskah, storyboard, dan prompt untuk layanan video yang telah dikonfigurasi.",
    systemPrompt: "Anda adalah video producer. Jelaskan deliverable yang benar-benar dibuat. Jangan mengklaim file video tersedia sebelum artefaknya tersimpan.",
    allowedTools: ["document.create", "artifact.create"],
    visualConfig: { shirt: "#5eaa8b", hair: "#49372f", skin: "#d9a27f", pants: "#4b5e68", hairstyle: "curly" }
  },
  {
    slug: "maya", name: "Maya", role: "Copywriter & Social Media AI", departmentCode: "creative",
    description: "Menulis naskah, caption, konten edukasi, dan kalender editorial sesuai persona merek.",
    systemPrompt: "Anda adalah copywriter. Sesuaikan tujuan dan audiens, jangan membuat klaim faktual tanpa dukungan, dan jangan menerbitkan konten eksternal tanpa approval.",
    allowedTools: ["document.create", "artifact.create"],
    visualConfig: { shirt: "#bf7698", hair: "#30282a", skin: "#d7a17d", pants: "#55506c", hairstyle: "long" }
  },
  {
    slug: "raka", name: "Raka", role: "Research & QA Specialist", departmentCode: "research",
    description: "Memeriksa sumber, membandingkan referensi, dan meninjau mutu keluaran agent.",
    systemPrompt: "Anda adalah spesialis riset dan QA. Bedakan fakta, inferensi, dan asumsi; catat referensi; laporkan kekurangan bukti; jangan menyatakan verifikasi yang tidak dilakukan.",
    allowedTools: ["research.search", "file.read", "artifact.create"],
    visualConfig: { shirt: "#887bb9", hair: "#514038", skin: "#edc09c", pants: "#46536a", hairstyle: "curly" }
  }
];

async function main() {
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const name = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || "Workspace Owner";
  if (!email || !password || password.startsWith("CHANGE_ME") || password.length < 12) {
    throw new Error("Set BOOTSTRAP_ADMIN_EMAIL and a unique BOOTSTRAP_ADMIN_PASSWORD (minimum 12 characters) in .env before seeding.");
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash, active: true },
    create: { email, name, passwordHash }
  });
  const workspace = await prisma.workspace.upsert({
    where: { slug: "kantorai-studio" },
    update: { name: "KantorAI Studio", ownerId: admin.id },
    create: { name: "KantorAI Studio", slug: "kantorai-studio", ownerId: admin.id }
  });
  const departmentByCode = new Map<string, string>();
  for (const department of departments) {
    const result = await prisma.department.upsert({
      where: { workspaceId_code: { workspaceId: workspace.id, code: department.code } },
      update: { name: department.name, description: department.description, sortOrder: department.sortOrder },
      create: { workspaceId: workspace.id, ...department }
    });
    departmentByCode.set(department.code, result.id);
  }
  for (const agent of agents) {
    const { departmentCode, ...data } = agent;
    await prisma.agent.upsert({
      where: { workspaceId_slug: { workspaceId: workspace.id, slug: agent.slug } },
      update: {
        name: data.name, role: data.role, description: data.description, systemPrompt: data.systemPrompt,
        allowedTools: data.allowedTools, visualConfig: data.visualConfig,
        departmentId: departmentByCode.get(departmentCode)
      },
      create: {
        workspaceId: workspace.id, ...data,
        departmentId: departmentByCode.get(departmentCode)
      }
    });
  }
  console.log(`Seed selesai: ${admin.email}, workspace ${workspace.slug}, ${departments.length} departemen, ${agents.length} agent awal.`);
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
