import fs from 'fs';
import path from 'path';
import * as XLSXModule from 'xlsx';
import sharp from 'sharp';
import { bacaUserKeys } from './keys.js';

const XLSX = XLSXModule.default || XLSXModule;

export const WORKSPACE = './workspace';
export const UPLOADS_DIR = './uploads';
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

async function jalankanGeminiImageEdit(srcBuffer, instruksiEdit) {
  const geminiKey = bacaUserKeys().gemini;
  if (!geminiKey) return { ok: false, alasan: 'API Key Gemini belum dipasang.' };

  const pngBuf = await sharp(srcBuffer).rotate().png().toBuffer();
  const base64Img = pngBuf.toString('base64');
  const models = ['gemini-2.5-flash-image', 'gemini-2.0-flash-exp-image-generation'];

  let errorTerakhir = '';
  for (const modelName of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${encodeURIComponent(geminiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: `Edit the attached image accurately:\n${instruksiEdit}\nPreserve layout, colors, icons, and numbers cleanly.` },
              { inline_data: { mime_type: 'image/png', data: base64Img } }
            ]
          }],
          generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
        })
      });
      const data = await res.json();
      if (!res.ok) {
        errorTerakhir = data?.error?.message || `HTTP ${res.status}`;
        continue;
      }
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
      const outBase64 = imgPart?.inlineData?.data || imgPart?.inline_data?.data;
      if (outBase64) return { ok: true, buffer: Buffer.from(outBase64, 'base64'), model: modelName };
    } catch (err) {
      errorTerakhir = err.message;
    }
  }
  return { ok: false, alasan: errorTerakhir };
}

async function ambilWarnaLatarOtomatis(baseBuffer, w, h, bx, by, bw, bh) {
  try {
    const sampleY = by >= 5 ? by - 4 : Math.min(h - 3, by + bh + 1);
    const sampleX = Math.max(0, Math.min(w - 4, bx + Math.floor(bw * 0.15)));
    const sampleW = Math.max(4, Math.min(w - sampleX, Math.floor(bw * 0.7)));
    const sampleH = Math.max(2, Math.min(3, h - sampleY));

    const { data, info } = await sharp(baseBuffer)
      .extract({ left: sampleX, top: sampleY, width: sampleW, height: sampleH })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    let r = 0, g = 0, b = 0;
    const pixels = info.width * info.height;
    for (let i = 0; i < data.length; i += 3) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    const toHex = (n) => Math.round(n / pixels).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch (e) {
    return '#d6c7b2';
  }
}

function bersihkanHtmlKeTeks(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  const desc = descMatch ? descMatch[1].trim() : '';

  const bodyBersih = html
    .replace(/<(script|style|noscript|svg|iframe|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();

  const headerInfo = [
    title ? `Judul Halaman: ${title}` : '',
    desc ? `Meta Deskripsi: ${desc}` : ''
  ].filter(Boolean).join('\n');

  return `${headerInfo ? headerInfo + '\n---\n' : ''}${bodyBersih}`;
}

export function buatAlatKantor(namaAgent, fileSudahDibaca, broadcast) {
  return {
    lihat_folder: () => {
      const files = fs.readdirSync(WORKSPACE);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: 'Mengecek isi workspace' });
      return files.length > 0 ? files.join(', ') : 'Folder workspace masih kosong.';
    },
    tulis_file: ({ nama_file, isi_kode }) => {
      const filePath = path.join(WORKSPACE, nama_file);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, isi_kode, 'utf-8');
      fileSudahDibaca.add(nama_file);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Menyimpan ${nama_file}` });
      return `Sukses menyimpan ${nama_file}`;
    },
    edit_file: ({ nama_file, teks_lama, teks_baru }) => {
      const cleanName = path.normalize(nama_file).replace(/^(\.\.(\/|\\|$))+/, '');
      const filePath = path.join(WORKSPACE, cleanName);
      if (!fs.existsSync(filePath)) return `Error: File ${cleanName} tidak ditemukan.`;

      const kontenAsli = fs.readFileSync(filePath, 'utf-8');
      let hasilEdit = null;

      if (kontenAsli.includes(teks_lama)) {
        hasilEdit = kontenAsli.replace(teks_lama, teks_baru);
      } else {
        const normKonten = kontenAsli.replace(/\r\n/g, '\n');
        const normLama = (teks_lama || '').replace(/\r\n/g, '\n');
        const normBaru = (teks_baru || '').replace(/\r\n/g, '\n');
        if (normLama && normKonten.includes(normLama)) {
          hasilEdit = normKonten.replace(normLama, normBaru);
        }
      }

      if (hasilEdit === null) {
        return `Error: teks_lama tidak cocok persis di ${cleanName}. Cuplikan kode:\n${kontenAsli.slice(0, 2200)}`;
      }

      fs.writeFileSync(filePath, hasilEdit, 'utf-8');
      fileSudahDibaca.add(cleanName);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Mengedit ${cleanName}` });
      return `Sukses mengedit ${cleanName}`;
    },
    baca_file: ({ nama_file }) => {
      if (fileSudahDibaca.has(nama_file)) {
        return `Catatan: ${nama_file} sudah dibaca. Langsung lanjutkan keputusan.`;
      }
      const filePath = path.join(WORKSPACE, nama_file);
      if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
      fileSudahDibaca.add(nama_file);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membaca ${nama_file}` });

      if (nama_file.endsWith('.xlsx') || nama_file.endsWith('.xls')) {
        const wb = XLSX.readFile(filePath);
        return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).slice(0, 4500);
      }

      const isi = fs.readFileSync(filePath, 'utf-8').replace(/^\s*[\r\n]/gm, '');
      return isi.length > 4500 ? isi.slice(0, 4500) + '\n/* ...dipotong... */' : isi;
    },
    baca_url: async ({ url }) => {
      let targetUrl;
      try {
        targetUrl = new URL(url);
        if (!['http:', 'https:'].includes(targetUrl.protocol)) {
          return 'Error: URL harus diawali http:// atau https://';
        }
      } catch (e) {
        return `Error: Format URL tidak valid (${url}).`;
      }

      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membaca URL ${targetUrl.hostname}` });

      try {
        const res = await fetch(targetUrl.href, {
          signal: AbortSignal.timeout(12000),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8'
          }
        });

        if (!res.ok) {
          return `Error HTTP ${res.status} saat membuka ${targetUrl.href} (halaman mungkin memblokir bot atau memerlukan login).`;
        }

        const contentType = res.headers.get('content-type') || '';
        const rawText = await res.text();

        if (contentType.includes('application/json') || contentType.includes('text/plain')) {
          return `[ISI URL: ${targetUrl.href}]\n${rawText.slice(0, 9000)}`;
        }

        const teksBersih = bersihkanHtmlKeTeks(rawText);
        if (!teksBersih || teksBersih.length < 30) {
          return `Halaman ${targetUrl.href} berhasil dibuka tetapi konten teksnya kosong (kemungkinan halaman berbasis JavaScript SPA penuh).`;
        }

        return `[ISI URL: ${targetUrl.href}]\n${teksBersih.slice(0, 9000)}`;
      } catch (err) {
        return `Gagal mengakses ${targetUrl.href}: ${err.name === 'TimeoutError' ? 'Koneksi timeout (lebih dari 12 detik)' : err.message}`;
      }
    },
    buat_excel: ({ nama_file, nama_sheet, data_baris }) => {
      const namaFix = nama_file.endsWith('.xlsx') ? nama_file : `${nama_file}.xlsx`;
      const filePath = path.join(WORKSPACE, namaFix);
      const wb = XLSX.utils.book_new();

      const dataTerformat = data_baris.map((baris) =>
        baris.map((sel) => {
          if (typeof sel === 'string') {
            const trimmed = sel.trim();
            if (trimmed.startsWith('=')) return { t: 'n', f: trimmed.slice(1), z: '#,##0' };
            if (trimmed !== '' && !isNaN(Number(trimmed))) return { t: 'n', v: Number(trimmed), z: '#,##0' };
          } else if (typeof sel === 'number') {
            return { t: 'n', v: sel, z: '#,##0' };
          }
          return sel;
        })
      );

      const ws = XLSX.utils.aoa_to_sheet(dataTerformat);
      const maxCols = Math.max(...data_baris.map((r) => r.length));
      ws['!cols'] = Array.from({ length: maxCols }, (_, colIdx) => {
        const panjangMaks = Math.max(...data_baris.map((r) => String(r[colIdx] ?? '').length), 10);
        return { wch: Math.min(panjangMaks + 4, 42) };
      });

      XLSX.utils.book_append_sheet(wb, ws, nama_sheet || 'Sheet1');
      XLSX.writeFile(wb, filePath);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membuat Excel ${namaFix}` });
      return `Sukses membuat file Excel ${namaFix}`;
    },
    edit_image: async (args) => {
      const safeSrcName = path.basename(args.sourceFile || '');
      const pathInWorkspace = path.join(WORKSPACE, safeSrcName);
      const pathInUploads = path.join(UPLOADS_DIR, safeSrcName);
      const srcPath = fs.existsSync(pathInWorkspace)
        ? pathInWorkspace
        : fs.existsSync(pathInUploads)
          ? pathInUploads
          : null;

      if (!srcPath) return `Error: File gambar '${safeSrcName}' tidak ditemukan.`;

      const rawExt = path.extname(args.outputName || '').toLowerCase();
      const outExt = rawExt === '.jpg' || rawExt === '.jpeg' ? '.jpg' : '.png';
      const baseOut = path.basename(args.outputName || 'hasil-edit.png', rawExt || undefined).replace(/\s+/g, '-');
      const finalOutName = `${baseOut}${outExt}`;
      const outPath = path.join(WORKSPACE, finalOutName);

      const srcBuffer = fs.readFileSync(srcPath);
      const origMeta = await sharp(srcBuffer).rotate().metadata();
      let workingBuffer = srcBuffer;
      let metodeDipakai = 'Sharp';

      if (args.editInstruction && String(args.editInstruction).trim().length > 0) {
        broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: 'Memproses gambar dengan AI...' });
        const aiResult = await jalankanGeminiImageEdit(srcBuffer, args.editInstruction);
        if (aiResult.ok && aiResult.buffer) {
          workingBuffer = aiResult.buffer;
          metodeDipakai = `AI (${aiResult.model})`;
        }
      }

      let pipeline = sharp(workingBuffer).rotate();
      if (metodeDipakai.startsWith('AI') && origMeta.width && origMeta.height && !args.resizeWidth && !args.resizeHeight && !args.crop) {
        pipeline = pipeline.resize(origMeta.width, origMeta.height, { fit: 'fill' });
      }
      if (args.crop?.width && args.crop?.height) {
        pipeline = pipeline.extract({
          left: Math.max(0, Math.round(args.crop.left || 0)),
          top: Math.max(0, Math.round(args.crop.top || 0)),
          width: Math.round(args.crop.width),
          height: Math.round(args.crop.height)
        });
      }
      if (args.rotate) pipeline = pipeline.rotate(Number(args.rotate));
      if (args.grayscale) pipeline = pipeline.grayscale();
      if (args.resizeWidth || args.resizeHeight) {
        pipeline = pipeline.resize(args.resizeWidth || null, args.resizeHeight || null, { fit: 'inside' });
      }

      const baseBuffer = await pipeline.toBuffer();
      const meta = await sharp(baseBuffer).metadata();
      const w = meta.width || 800;
      const h = meta.height || 600;

      const listReplacements = !metodeDipakai.startsWith('AI') && Array.isArray(args.replacements) ? args.replacements : [];
      let finalImage = sharp(baseBuffer);

      if (listReplacements.length > 0) {
        const escapeXml = (s) => String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
        const bgRects = [];
        const textTags = [];

        for (const r of listReplacements) {
          const bx = Math.round(((Number(r.xmin) || 0) / 1000) * w);
          const by = Math.round(((Number(r.ymin) || 0) / 1000) * h);
          const bw = Math.max(12, Math.round((((Number(r.xmax) || 80) - (Number(r.xmin) || 0)) / 1000) * w));
          const bh = Math.max(12, Math.round((((Number(r.ymax) || 30) - (Number(r.ymin) || 0)) / 1000) * h));
          const sampledHex = await ambilWarnaLatarOtomatis(baseBuffer, w, h, bx, by, bw, bh);
          const fontSize = Math.max(9, Math.min(32, Math.floor(Math.min((bw * 0.9) / (Math.max(String(r.text || '').length, 1) * 0.55), bh * 0.75))));

          bgRects.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${sampledHex}" rx="6" />`);
          textTags.push(`<text x="${Math.round(bx + bw / 2)}" y="${Math.round(by + bh / 2)}" text-anchor="middle" dominant-baseline="central" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="${r.textColor || '#1e1b18'}">${escapeXml(r.text)}</text>`);
        }

        const svgOverlay = Buffer.from(
          `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.8" /></filter></defs><g filter="url(#soft)">${bgRects.join('')}</g>${textTags.join('')}</svg>`
        );
        finalImage = finalImage.composite([{ input: svgOverlay, top: 0, left: 0 }]);
        metodeDipakai = 'Sharp Fallback';
      }

      if (outExt === '.jpg') await finalImage.jpeg({ quality: 92 }).toFile(outPath);
      else await finalImage.png().toFile(outPath);

      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Menyimpan ${finalOutName} (${metodeDipakai})` });
      return `Berhasil menyimpan gambar ke '${finalOutName}' (${w}x${h}px).`;
    }
  };
}

export const daftarSkemaTools = [
  {
    type: 'function',
    function: {
      name: 'lihat_folder',
      description: 'Melihat daftar file di folder workspace.',
      parameters: { type: 'object', properties: { cek: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tulis_file',
      description: 'Membuat file baru (HTML, CSS, JS, Markdown, CSV, TXT) di workspace.',
      parameters: {
        type: 'object',
        properties: { nama_file: { type: 'string' }, isi_kode: { type: 'string' } },
        required: ['nama_file', 'isi_kode']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Mengganti sebagian teks/kode di file yang sudah ada.',
      parameters: {
        type: 'object',
        properties: { nama_file: { type: 'string' }, teks_lama: { type: 'string' }, teks_baru: { type: 'string' } },
        required: ['nama_file', 'teks_lama', 'teks_baru']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'baca_file',
      description: 'Membaca isi file di workspace (cukup 1x per file).',
      parameters: {
        type: 'object',
        properties: { nama_file: { type: 'string' } },
        required: ['nama_file']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'baca_url',
      description: 'Mengambil dan membaca isi teks, judul, serta meta deskripsi dari sebuah URL website (http/https).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Alamat URL lengkap yang diawali http:// atau https://' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buat_excel',
      description: 'Membuat file spreadsheet Excel (.xlsx) asli dari array 2D (baris & kolom).',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          nama_sheet: { type: 'string' },
          data_baris: { type: 'array', items: { type: 'array', items: { type: 'string' } } }
        },
        required: ['nama_file', 'data_baris']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_image',
      description: 'Mengedit gambar dari folder uploads atau workspace (crop, resize, rotate, grayscale, watermark/edit visual) lalu menyimpannya sebagai .png atau .jpg.',
      parameters: {
        type: 'object',
        properties: {
          sourceFile: { type: 'string' },
          outputName: { type: 'string' },
          editInstruction: { type: 'string' },
          resizeWidth: { type: 'number' },
          resizeHeight: { type: 'number' },
          grayscale: { type: 'boolean' },
          rotate: { type: 'number' },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                ymin: { type: 'number' }, xmin: { type: 'number' },
                ymax: { type: 'number' }, xmax: { type: 'number' },
                text: { type: 'string' }, textColor: { type: 'string' }
              },
              required: ['ymin', 'xmin', 'ymax', 'xmax', 'text', 'textColor']
            }
          }
        },
        required: ['sourceFile', 'outputName']
      }
    }
  }
];