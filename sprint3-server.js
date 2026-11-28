import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import { KEYS_FILE, bacaUserKeys, maskKey } from './lib/keys.js';
import { ekstrakIsiFile } from './lib/extractor.js';
import { WORKSPACE, UPLOADS_DIR } from './lib/tools.js';
import { panggilKaryawan } from './lib/ai-router.js';

let sedangSibuk = false;
let activeAbortController = null;
let riwayatChatSingkat = [];

function bacaSOP(divisi) {
  const sopPath = path.join(import.meta.dirname, 'sop', `${divisi}.md`);
  return fs.readFileSync(sopPath, 'utf-8');
}

const MIME_MAP = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/monitor.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync('./monitor.html', 'utf-8'));
  }

  if (req.url.startsWith('/preview/')) {
    const rawPath = decodeURIComponent(req.url.replace('/preview/', '').split('?')[0]);
    const cleanRel = path.normalize(rawPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const filePath = path.resolve(WORKSPACE, cleanRel);

    if (filePath.startsWith(path.resolve(WORKSPACE)) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
      return res.end(fs.readFileSync(filePath));
    }
  }

  if (req.url === '/api/keys' && req.method === 'GET') {
    const k = bacaUserKeys();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      gemini: Boolean(k.gemini),
      groq: Boolean(k.groq),
      openrouter: Boolean(k.openrouter),
      masked: { gemini: maskKey(k.gemini), groq: maskKey(k.groq), openrouter: maskKey(k.openrouter) }
    }));
  }

  if (req.url === '/api/keys' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const current = bacaUserKeys();
      const { gemini, groq, openrouter, clear } = JSON.parse(body || '{}');
      if (clear && current[clear] !== undefined) current[clear] = '';
      else {
        if (gemini) current.gemini = gemini;
        if (groq) current.groq = groq;
        if (openrouter) current.openrouter = openrouter;
      }
      fs.writeFileSync(KEYS_FILE, JSON.stringify(current, null, 2), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/cancel') {
    if (sedangSibuk && activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
      sedangSibuk = false;
      broadcast({
        type: 'DIBATALKAN',
        pesan: 'Tugas dihentikan oleh user.',
        files: fs.readdirSync(WORKSPACE)
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: 'Tidak ada tugas yang sedang berjalan.' }));
  }

  if (req.method === 'POST' && req.url === '/api/order') {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      if (sedangSibuk) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Kantor masih mengerjakan tugas sebelumnya.' }));
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        await jalankanAlurKantor(body.prompt || '', body.files || [], body.resetWorkspace);
      } catch (err) {
        sedangSibuk = false;
        activeAbortController = null;
        console.error('Error:', err.message);
        broadcast({ type: 'ERROR', pesan: err.message });
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

const wss = new WebSocketServer({ server });

function broadcast(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(data);
  });
}

function ambilGambarHasilWorkspace() {
  const hasil = [];
  for (const file of fs.readdirSync(WORKSPACE)) {
    const ext = path.extname(file).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const buf = fs.readFileSync(path.join(WORKSPACE, file));
      hasil.push({ nama: file, dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
    }
  }
  return hasil;
}

async function jalankanAlurKantor(promptUser, filesLampiran, resetWorkspace = false) {
  const myController = new AbortController();
  activeAbortController = myController;
  const signal = myController.signal;
  sedangSibuk = true;
  const stateToken = { total: 0 };

  try {
    if (resetWorkspace) {
      for (const item of fs.readdirSync(WORKSPACE)) {
        try { fs.rmSync(path.join(WORKSPACE, item), { recursive: true, force: true }); } catch (e) {}
      }
      riwayatChatSingkat = [];
    }

    let blokTeksLampiran = '';
    const gambarLampiran = [];

    for (const f of filesLampiran) {
      if (signal.aborted) throw new Error('ABORTED_BY_USER');
      const buffer = Buffer.from(f.base64, 'base64');
      fs.writeFileSync(path.join(UPLOADS_DIR, path.basename(f.name)), buffer);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: 'Manager', aksi: `Memproses lampiran ${f.name}` });

      const hasil = await ekstrakIsiFile(f.name, buffer);
      if (hasil.tipe === 'gambar') {
        gambarLampiran.push(hasil);
        blokTeksLampiran += `\n${hasil.infoTeks}`;
      } else {
        blokTeksLampiran += `\n\n${hasil.konten}`;
      }
    }

    const adaGambar = gambarLampiran.length > 0;
    const konteksSebelumnya = riwayatChatSingkat.length > 0
      ? `\n[Konteks percakapan terakhir]: ${riwayatChatSingkat.slice(-2).join(' | ')}\n`
      : '';
    const teksLengkap = `${konteksSebelumnya}Permintaan User:\n${promptUser}${blokTeksLampiran}`;

    const susunUserContent = (instruksiTambahan = '') => {
      const teksFinal = instruksiTambahan ? `${instruksiTambahan}\n\n${teksLengkap}` : teksLengkap;
      if (!adaGambar) return teksFinal;
      return [
        { type: 'text', text: teksFinal },
        ...gambarLampiran.map((g) => ({ type: 'image_url', image_url: { url: g.dataUrl } }))
      ];
    };

    broadcast({ type: 'PINDAH_MEJA', dari: 'User', ke: 'Manager', pesan: 'Menganalisis brief & file lampiran...' });

    const keputusanManager = await panggilKaryawan({
      namaAgent: 'Manager',
      systemPrompt: bacaSOP('manager'),
      userContent: susunUserContent(),
      izinTools: [],
      butuhVision: adaGambar,
      maxSteps: 2,
      stateToken,
      broadcast,
      signal
    });

    let jawabanAkhir = '';

    if (keputusanManager.trim().startsWith('JALUR_WEB')) {
      broadcast({ type: 'PINDAH_MEJA', dari: 'Manager', ke: 'Web Coder', pesan: 'Mendelegasikan eksekusi teknis & media...' });

      const ringkasanCoder = await panggilKaryawan({
        namaAgent: 'Web Coder',
        systemPrompt: bacaSOP('coder'),
        userContent: susunUserContent(`Arahan Manager: ${keputusanManager}`),
        izinTools: ['lihat_folder', 'tulis_file', 'edit_file', 'baca_file', 'edit_image'],
        butuhVision: adaGambar,
        stateToken,
        broadcast,
        signal
      });

      broadcast({ type: 'PINDAH_MEJA', dari: 'Web Coder', ke: 'QA Reviewer', pesan: 'Memeriksa kualitas & hasil visual...' });

      const gambarOutputQA = adaGambar ? ambilGambarHasilWorkspace() : [];
      const qaPromptText = `Periksa hasil pekerjaan di workspace untuk request: "${promptUser}".${gambarOutputQA.length > 0 ? ` Gambar pertama = asli, gambar berikutnya = hasil (${gambarOutputQA.map((g) => g.nama).join(', ')}).` : ''}`;
      const qaUserContent = gambarOutputQA.length > 0
        ? [
            { type: 'text', text: qaPromptText },
            ...gambarLampiran.map((g) => ({ type: 'image_url', image_url: { url: g.dataUrl } })),
            ...gambarOutputQA.map((g) => ({ type: 'image_url', image_url: { url: g.dataUrl } }))
          ]
        : qaPromptText;

      const reviewQA = await panggilKaryawan({
        namaAgent: 'QA Reviewer',
        systemPrompt: bacaSOP('qa'),
        userContent: qaUserContent,
        izinTools: ['lihat_folder', 'baca_file'],
        butuhVision: gambarOutputQA.length > 0,
        maxSteps: 4,
        stateToken,
        broadcast,
        signal
      });

      if (!reviewQA.trim().startsWith('APPROVED')) {
        broadcast({ type: 'PINDAH_MEJA', dari: 'QA Reviewer', ke: 'Web Coder', pesan: 'Mengirim catatan revisi ke Web Coder...' });
        await panggilKaryawan({
          namaAgent: 'Web Coder',
          systemPrompt: bacaSOP('coder'),
          userContent: susunUserContent(`Perbaiki temuan QA berikut:\n${reviewQA}`),
          izinTools: ['lihat_folder', 'tulis_file', 'edit_file', 'baca_file', 'edit_image'],
          butuhVision: adaGambar,
          stateToken,
          broadcast,
          signal
        });
      }

      jawabanAkhir = `Tugas selesai dikerjakan dan sudah dicek oleh QA Reviewer.\n${ringkasanCoder}`;
    } else {
      broadcast({ type: 'PINDAH_MEJA', dari: 'Manager', ke: 'Analyst', pesan: 'Mendelegasikan analisis dokumen & problem solving...' });

      jawabanAkhir = await panggilKaryawan({
        namaAgent: 'Analyst',
        systemPrompt: bacaSOP('analyst'),
        userContent: susunUserContent(`Arahan Manager: ${keputusanManager}`),
        izinTools: ['lihat_folder', 'baca_file', 'tulis_file', 'edit_file', 'buat_excel', 'edit_image', 'baca_url','bedah_figma_json','ambil_detail_layar_figma','buat_word','buat_ppt','buat_pdf'],
        butuhVision: adaGambar,
        stateToken,
        broadcast,
        signal
      });
    }

    riwayatChatSingkat.push(`User: ${promptUser.slice(0, 120)} -> Hasil: ${jawabanAkhir.slice(0, 150)}`);
    broadcast({
      type: 'SELESAI',
      jawaban: jawabanAkhir,
      files: fs.readdirSync(WORKSPACE),
      totalToken: stateToken.total
    });
  } catch (err) {
    if (signal.aborted || err.message === 'ABORTED_BY_USER') {
      console.log('   [CANCEL] Tugas dihentikan oleh user.');
      return;
    }
    console.error('Error:', err.message);
    broadcast({ type: 'ERROR', pesan: err.message });
  } finally {
    if (activeAbortController === myController) {
      activeAbortController = null;
      sedangSibuk = false;
    }
  }
}

server.listen(3000, () => {
  console.log('Kantor AI Full-Stack aktif! Buka di browser: http://localhost:3000');
});