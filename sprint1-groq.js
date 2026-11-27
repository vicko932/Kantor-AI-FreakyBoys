import Groq from 'groq-sdk';
import fs from 'fs';
import path from 'path';

// 1. Inisialisasi Otak (Groq API)
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY || ''
});

const WORKSPACE = './workspace';
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE);

// Kunci ke model yang sudah terbukti mendukung tool calling di Groq
let modelAktif = 'openai/gpt-oss-120b';

// 2. "Tangan" Agent (4 Fungsi Lokal)
const alatKantor = {
  lihat_folder: () => {
    const files = fs.readdirSync(WORKSPACE);
    console.log(`   [TOOL] Cek isi workspace`);
    return files.length > 0 ? files.join(', ') : 'Folder workspace masih kosong.';
  },
  tulis_file: ({ nama_file, isi_kode }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, isi_kode, 'utf-8');
    console.log(`   [TOOL] Tulis file baru: ${nama_file}`);
    return `Sukses menyimpan ${nama_file}`;
  },
  edit_file: ({ nama_file, teks_lama, teks_baru }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
    const konten = fs.readFileSync(filePath, 'utf-8');
    if (!konten.includes(teks_lama)) return 'Error: teks_lama tidak cocok persis dengan isi file.';
    fs.writeFileSync(filePath, konten.replace(teks_lama, teks_baru), 'utf-8');
    console.log(`   [TOOL] Edit sebagian: ${nama_file}`);
    return `Sukses mengedit ${nama_file}`;
  },
  baca_file: ({ nama_file }) => {
    const filePath = path.join(WORKSPACE, nama_file);
    if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
    console.log(`   [TOOL] Baca file: ${nama_file}`);
    return fs.readFileSync(filePath, 'utf-8');
  }
};

// 3. Buku Manual Alat (Format Function Calling)
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
          nama_file: { type: 'string', description: 'Contoh: index.html atau style.css' },
          isi_kode: { type: 'string', description: 'Isi lengkap kode yang akan ditulis' }
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
          teks_lama: { type: 'string', description: 'Potongan kode lama yang persis sama' },
          teks_baru: { type: 'string', description: 'Potongan kode pengganti' }
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

// Helper Auto-Retry yang menghindari model audio/guard
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
          console.log(`   [FALLBACK] Pindah otomatis ke model: ${modelAktif}`);
          continue;
        }
      }
      if ((err.status === 429 || err.status === 503) && i < maksimalCoba) {
        console.log(`   [TUNGGU] Limit/server sibuk (${err.status}), coba lagi dalam 4 detik...`);
        await new Promise((r) => setTimeout(r, 4000));
      } else {
        throw err;
      }
    }
  }
}

// 4. Jantung Agent (Looping Hemat Token)
async function jalankanWebCoderGroq(perintahUser) {
  console.log(`\nTugas masuk: "${perintahUser}"\n`);

  const memory = [
    {
      role: 'system',
      content:
        'Lu Senior Frontend Developer. Buat kode bersih, modern, responsif, dan pisahkan file HTML, CSS, dan JS. Panggil tool satu per satu secara berurutan. Gunakan edit_file jika hanya mengubah sebagian kode. DILARANG basa-basi, langsung panggil tool, dan setelah selesai balas maksimal 1 kalimat.'
    },
    { role: 'user', content: perintahUser }
  ];

  const MAX_STEPS = 10;
  let totalToken = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    const response = await panggilGroqDenganRetry({
      model: modelAktif,
      messages: memory,
      tools: daftarSkemaTools,
      tool_choice: 'auto',
      parallel_tool_calls: false
    });

    const usage = response.usage;
    if (usage) {
      totalToken += usage.total_tokens;
      console.log(`   [TOKEN Step ${step}] Input: ${usage.prompt_tokens} | Output: ${usage.completion_tokens}`);
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

          // Context Pruning: Hapus isi kode dari RAM setelah tersimpan di disk
          if (namaFungsi === 'tulis_file') {
            call.function.arguments = JSON.stringify({
              nama_file: args.nama_file,
              isi_kode: '[DISIMPAN_KE_DISK]'
            });
          }
        } catch (e) {
          output = 'Error: Argumen JSON tidak valid, silakan ulangi pemanggilan tool.';
        }

        memory.push({
          role: 'tool',
          tool_call_id: call.id,
          content: output
        });
      }
    } else {
      console.log(`\n[Web Coder Selesai]: ${pesanAsisten.content}`);
      console.log(`[Total Token Terpakai]: ${totalToken} tokens\n`);
      break;
    }
  }
}

const tugas =
  process.argv[2] ||
  'Buatkan landing page jasa web developer dark mode modern lengkap dengan index.html, style.css, dan script.js.';

jalankanWebCoderGroq(tugas);