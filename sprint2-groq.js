import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';

// 1. Inisialisasi Otak (Groq API)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || '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'
});

const WORKSPACE = './workspace';
let modelAktif = 'openai/gpt-oss-120b';
let totalTokenKantor = 0;

// 2. Kumpulan "Tangan" Kantor
const alatKantor = {
  lihat_folder: () => {
    const files = fs.readdirSync(WORKSPACE);
    console.log(`      [TOOL] Cek isi workspace`);
    return files.length > 0 ? files.join(', ') : 'Folder workspace masih kosong.';
  },
  tulis_file: ({ nama_file, isi_kode }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, isi_kode, 'utf-8');
    console.log(`      [TOOL] Tulis file: ${nama_file}`);
    return `Sukses menyimpan ${nama_file}`;
  },
  edit_file: ({ nama_file, teks_lama, teks_baru }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
    const konten = fs.readFileSync(filePath, 'utf-8');
    if (!konten.includes(teks_lama)) return 'Error: teks_lama tidak cocok persis dengan isi file.';
    fs.writeFileSync(filePath, konten.replace(teks_lama, teks_baru), 'utf-8');
    console.log(`      [TOOL] Edit sebagian: ${nama_file}`);
    return `Sukses mengedit ${nama_file}`;
  },
  baca_file: ({ nama_file }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
    console.log(`      [TOOL] Baca file: ${nama_file}`);
    return fs.readFileSync(filePath, 'utf-8');
  }
};

// 3. Buku Manual Semua Alat
const daftarSkemaTools = [
  {
    type: 'function',
    function: {
      name: 'lihat_folder',
      description: 'Melihat daftar file yang ada di folder workspace.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tulis_file',
      description: 'Membuat file kode baru atau menimpa file di folder workspace.',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          isi_kode: { type: 'string' }
        },
        required: ['nama_file', 'isi_kode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Mengganti sebagian kode di file yang sudah ada tanpa menulis ulang seluruh file.',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          teks_lama: { type: 'string' },
          teks_baru: { type: 'string' }
        },
        required: ['nama_file', 'teks_lama', 'teks_baru']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'baca_file',
      description: 'Membaca isi file yang ada di workspace.',
      parameters: {
        type: 'object',
        properties: { nama_file: { type: 'string' } },
        required: ['nama_file']
      }
    }
  }
];

// Helper Auto-Retry
async function panggilGroqDenganRetry(params, maksimalCoba = 4) {
  const modelDilewati = new Set();

  for (let i = 1; i <= maksimalCoba; i++) {
    try {
      return await groq.chat.completions.create({ ...params, model: modelAktif });
    } catch (err) {
      if ((err.status === 404 || err.status === 400) && i < maksimalCoba) {
        modelDilewati.add(modelAktif);
        const list = await groq.models.list();
        const cadangan = list.data.find(
          (m) =>
            !modelDilewati.has(m.id) &&
            !m.id.includes('whisper') &&
            !m.id.includes('guard') &&
            !m.id.includes('tts') &&
            !m.id.includes('orpheus') &&
            !m.id.includes('safeguard')
        );
        if (cadangan) {
          modelAktif = cadangan.id;
          console.log(`      [FALLBACK] Pindah ke model: ${modelAktif}`);
          continue;
        }
      }
      if ((err.status === 429 || err.status === 503) && i < maksimalCoba) {
        console.log(`      [TUNGGU] Server sibuk (${err.status}), coba lagi dalam 4 detik...`);
        await new Promise((r) => setTimeout(r, 4000));
      } else {
        throw err;
      }
    }
  }
}

// 4. Mesin Umum Karyawan AI (Bisa dipakai siapa saja dengan jabatan & alat berbeda)
async function panggilKaryawan({ namaAgent, systemPrompt, tugas, izinTools, maxSteps = 8 }) {
  console.log(`\n========================================`);
  console.log(`[MEJA ${namaAgent.toUpperCase()}] Mulai bekerja...`);
  console.log(`========================================`);

  // Filter buku manual alat sesuai jabatan karyawan ini
  const toolsKaryawan = daftarSkemaTools.filter((t) => izinTools.includes(t.function.name));

  // Tiap karyawan mulai dengan ingatan (RAM) bersih agar super hemat token
  const memory = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: tugas }
  ];

  for (let step = 1; step <= maxSteps; step++) {
    const response = await panggilGroqDenganRetry({
      model: modelAktif,
      messages: memory,
      tools: toolsKaryawan,
      tool_choice: 'auto',
      parallel_tool_calls: false
    });

    if (response.usage) {
      totalTokenKantor += response.usage.total_tokens;
    }

    const pesanAsisten = response.choices[0].message;
    memory.push(pesanAsisten);

    if (pesanAsisten.tool_calls && pesanAsisten.tool_calls.length > 0) {
      for (const call of pesanAsisten.tool_calls) {
        const namaFungsi = call.function.name;
        let output = '';

        try {
          const args = JSON.parse(call.function.arguments);
          const fungsi = alatKantor[namaFungsi];
          output = fungsi ? fungsi(args) : 'Tool tidak dikenal';

          // Context Pruning: buang isi kode besar dari RAM setelah disimpan ke disk
          if (namaFungsi === 'tulis_file') {
            call.function.arguments = JSON.stringify({
              nama_file: args.nama_file,
              isi_kode: '[DISIMPAN_KE_DISK]'
            });
          }
        } catch (e) {
          output = 'Error: Argumen JSON tidak valid, ulangi tool call.';
        }

        memory.push({
          role: 'tool',
          tool_call_id: call.id,
          content: output
        });
      }
    } else {
      console.log(`[${namaAgent} Selesai]:\n${pesanAsisten.content}`);
      return pesanAsisten.content;
    }
  }

  return 'Batas langkah tercapai.';
}

// 5. SOP Masing-Masing Karyawan
const SOP_CODER = `Lu adalah Senior Frontend Web Developer.
Tugas lu membuat atau memperbaiki kode website di folder workspace (pisahkan HTML, CSS, dan JS).
- Saat memperbaiki revisi dari QA, wajib panggil baca_file dulu pada file terkait, lalu gunakan edit_file agar hemat token.
- Panggil tool satu per satu secara berurutan.
- DILARANG basa-basi. Setelah selesai balas maksimal 1 kalimat.`;

const SOP_QA = `Lu adalah QA Engineer & Code Reviewer yang teliti.
Langkah wajib:
1. Panggil lihat_folder untuk melihat semua file di workspace.
2. Panggil baca_file pada SETIAP file yang ada.
3. Periksa apakah:
   - Link <link rel="stylesheet"> dan <script src="..."> di HTML cocok dengan nama file asli.
   - Semua ID dan Class yang dipanggil di JavaScript/CSS benar-benar ada di HTML.
   - Tidak ada sintaks error atau fitur yang diminta user terlewat.
Aturan jawaban akhir (WAJIB IKUTI FORMAT INI):
- Jika semua sudah benar dan siap pakai, awali jawaban persis dengan kata: APPROVED: (diikuti 1 kalimat ringkasan).
- Jika ada bug atau kekurangan, awali jawaban persis dengan kata: REVISI: (diikuti poin singkat perbaikan spesifik yang harus dilakukan Coder).`;

// 6. Orchestrator (Alur Kerja Kantor)
async function bukaKantorAI(requestUser) {
  console.log(`\n>>> ORDER BARU MASUK KANTOR: "${requestUser}" <<<`);

  // Bersihkan workspace untuk project baru
  fs.rmSync(WORKSPACE, { recursive: true, force: true });
  fs.mkdirSync(WORKSPACE);

  // Tahap 1: Web Coder membuat versi pertama
  await panggilKaryawan({
    namaAgent: 'Web Coder',
    systemPrompt: SOP_CODER,
    tugas: `Buatkan website sesuai permintaan berikut:\n${requestUser}`,
    izinTools: ['lihat_folder', 'tulis_file', 'edit_file', 'baca_file'],
    maxSteps: 8
  });

  // Tahap 2: Siklus Pengecekan QA & Revisi (Maksimal 2x revisi)
  const MAX_REVISI = 2;
  for (let putaran = 1; putaran <= MAX_REVISI; putaran++) {
    const hasilReview = await panggilKaryawan({
      namaAgent: 'QA Reviewer',
      systemPrompt: SOP_QA,
      tugas: `Periksa hasil website di folder workspace untuk request user ini: "${requestUser}"`,
      izinTools: ['lihat_folder', 'baca_file'], // QA hanya boleh baca, tidak boleh edit
      maxSteps: 6
    });

    if (hasilReview.trim().startsWith('APPROVED')) {
      console.log(`\n========================================`);
      console.log(`PROJECT LOLOS QA & SIAP DIPAKAI!`);
      console.log(`Total Token Seluruh Kantor: ${totalTokenKantor} tokens`);
      console.log(`========================================\n`);
      return;
    }

    // Jika belum APPROVED, lempar catatan revisi dari QA kembali ke meja Web Coder
    console.log(`\n>>> [MANAGER] Mengoper catatan revisi ke Web Coder (Putaran ${putaran}/${MAX_REVISI})...`);
    await panggilKaryawan({
      namaAgent: 'Web Coder',
      systemPrompt: SOP_CODER,
      tugas: `QA Reviewer menemukan masalah berikut pada kode lu:\n${hasilReview}\n\nSegera perbaiki file yang bermasalah menggunakan baca_file dan edit_file.`,
      izinTools: ['lihat_folder', 'tulis_file', 'edit_file', 'baca_file'],
      maxSteps: 6
    });
  }

  console.log(`\n[MANAGER] Batas maksimal revisi tercapai. Silakan cek hasil akhir di folder workspace.`);
  console.log(`Total Token Seluruh Kantor: ${totalTokenKantor} tokens\n`);
}

// Jalankan Kantor AI!
const order =
  process.argv[2] ||
  'Buatkan website kalkulator biaya pembuatan website interaktif (ada pilihan jumlah halaman dan fitur tambahan yang otomatis menghitung total harga) dengan tema dark mode.';

bukaKantorAI(order);