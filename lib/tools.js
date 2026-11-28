import fs from 'fs';
import path from 'path';
import * as XLSXModule from 'xlsx';
import sharp from 'sharp';
import { bacaUserKeys } from './keys.js';
import JSZipModule from 'jszip';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';
import PptxGenJSModule from 'pptxgenjs';
import PDFDocumentModule from 'pdfkit';

const JSZip = JSZipModule.default || JSZipModule;
const PptxGenJS = PptxGenJSModule.default || PptxGenJSModule;
const PDFDocument = PDFDocumentModule.default || PDFDocumentModule;
const XLSX = XLSXModule.default || XLSXModule;

export const WORKSPACE = './workspace';
export const UPLOADS_DIR = './uploads';
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function rgbKeHex(color, opacity = 1) {
  if (!color || typeof color.r !== 'number') return null;
  const skala = color.r <= 1 && color.g <= 1 && color.b <= 1 ? 255 : 1;
  const r = Math.max(0, Math.min(255, Math.round(color.r * skala)));
  const g = Math.max(0, Math.min(255, Math.round(color.g * skala)));
  const b = Math.max(0, Math.min(255, Math.round(color.b * skala)));
  const a = typeof color.a === 'number' ? color.a * opacity : opacity;
  if (a < 0.99) {
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(2))})`;
  }
  const toHex = (v) => v.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`.toUpperCase();
}

function daftarFileAssetLokal() {
  const kandidatFolder = [
    path.join(WORKSPACE, 'app', 'assets'),
    path.join(WORKSPACE, 'assets')
  ];
  const hasil = [];
  for (const dir of kandidatFolder) {
    if (fs.existsSync(dir)) {
      const relDir = path.relative(WORKSPACE, dir).replace(/\\/g, '/');
      const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
      for (const f of files) {
        hasil.push(`${relDir}/${f}`);
      }
    }
  }
  return hasil;
}

function ekstrakFills(fills) {
  if (!Array.isArray(fills)) return [];
  const hasil = [];
  for (const f of fills) {
    if (f.visible === false) continue;
    if (f.type === 'SOLID' && f.color) {
      const c = rgbKeHex(f.color, f.opacity ?? 1);
      if (c) hasil.push(c);
    } else if (f.type && f.type.startsWith('GRADIENT') && Array.isArray(f.gradientStops)) {
      const stops = f.gradientStops
        .map((s) => `${rgbKeHex(s.color)} ${Math.round((s.position || 0) * 100)}%`)
        .join(', ');
      hasil.push(`linear-gradient(${stops})`);
    } else if (f.type === 'IMAGE') {
      hasil.push(`[IMAGE_ASSET:${f.imageRef || 'embedded'}]`);
    }
  }
  return hasil;
}

function ekstrakRingkasanFigma(rawJson) {
  const pages = Array.isArray(rawJson?.document?.children)
    ? rawJson.document.children
    : [{ name: 'Default Page', children: Array.isArray(rawJson) ? rawJson : Object.values(rawJson || {}) }];

  const perHalaman = [];
  const daftarKomponenAsset = [];
  const hitungWarna = {};
  const hitungFont = {};
  let totalLayarSemuaHalaman = 0;

  function kumpulkanStyleDanTeks(node, daftarTeks, daftarKomponenDipakai) {
    if (!node || typeof node !== 'object') return;

    for (const c of ekstrakFills(node.fills)) {
      if (c.startsWith('#')) hitungWarna[c] = (hitungWarna[c] || 0) + 1;
    }

    if (node.type === 'INSTANCE' && node.name) {
      daftarKomponenDipakai.push(node.name);
    }

    if (node.type === 'TEXT') {
      if (node.characters && node.characters.trim()) {
        daftarTeks.push(node.characters.trim());
      }
      const fam = node.style?.fontFamily || node.fontName?.family;
      const size = node.style?.fontSize || node.fontSize;
      if (fam) {
        const kunciFont = size ? `${fam} (${Math.round(size)}px)` : fam;
        hitungFont[kunciFont] = (hitungFont[kunciFont] || 0) + 1;
      }
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        kumpulkanStyleDanTeks(child, daftarTeks, daftarKomponenDipakai);
      }
    }
  }

  for (const page of pages) {
    const namaHalaman = page.name || 'Tanpa Nama Halaman';
    const isHalamanAsset = namaHalaman.toLowerCase().includes('asset');
    const layarDiHalaman = [];

    function telusuriNode(node, kedalaman = 0) {
      if (!node || typeof node !== 'object') return;
      const lebar = node.absoluteBoundingBox?.width ?? node.width ?? 0;
      const tinggi = node.absoluteBoundingBox?.height ?? node.height ?? 0;

      if (isHalamanAsset) {
        if (['COMPONENT', 'COMPONENT_SET', 'FRAME', 'GROUP', 'VECTOR'].includes(node.type) && kedalaman <= 2) {
          daftarKomponenAsset.push({
            id: node.id || null,
            namaAsset: node.name || 'Asset',
            tipe: node.type,
            ukuran: lebar && tinggi ? `${Math.round(lebar)}x${Math.round(tinggi)}` : null
          });
          return;
        }
      } else {
        const adalahLayar =
          (node.type === 'FRAME' || node.type === 'COMPONENT') &&
          (kedalaman <= 1 || (lebar >= 300 && tinggi >= 500));

        if (adalahLayar) {
          const teksLayar = [];
          const komponenDipakai = [];
          kumpulkanStyleDanTeks(node, teksLayar, komponenDipakai);
          layarDiHalaman.push({
            id: node.id || null,
            namaLayar: node.name || 'Tanpa Nama',
            ukuran: lebar && tinggi ? `${Math.round(lebar)}x${Math.round(tinggi)}` : null,
            layout: node.layoutMode || 'NONE',
            navigasiKeNodeId: node.transitionNodeID || null,
            komponenAssetDipakai: [...new Set(komponenDipakai)].slice(0, 20),
            teksUtama: [...new Set(teksLayar)].slice(0, 25)
          });
          return;
        }
      }

      if (Array.isArray(node.children)) {
        for (const child of node.children) {
          telusuriNode(child, kedalaman + 1);
        }
      }
    }

    if (Array.isArray(page.children)) {
      for (const child of page.children) {
        telusuriNode(child, 0);
      }
    }

    if (!isHalamanAsset) {
      totalLayarSemuaHalaman += layarDiHalaman.length;
      perHalaman.push({
        namaHalamanFigma: namaHalaman,
        jumlahLayar: layarDiHalaman.length,
        daftarLayar: layarDiHalaman
      });
    }
  }

  const paletWarna = Object.entries(hitungWarna)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([hex, jumlah]) => ({ hex, jumlah }));

  const tipografi = Object.entries(hitungFont)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([font, jumlah]) => ({ font, jumlah }));

  return {
    totalHalamanUI: perHalaman.length,
    totalLayarSemuaHalaman,
    fileAssetLokalTersedia: daftarFileAssetLokal(),
    komponenDiHalamanAssets: daftarKomponenAsset,
    paletWarnaUtama: paletWarna,
    tipografiUtama: tipografi,
    strukturPerHalaman: perHalaman
  };
}

function ringkasNodeUntukKode(node, rootBox = null, kedalaman = 0) {
  if (!node || typeof node !== 'object' || kedalaman > 14 || node.visible === false) return null;

  const box = node.absoluteBoundingBox;
  const baseBox = rootBox || box;

  const hasil = {
    name: node.name,
    type: node.type
  };

  if (node.type === 'INSTANCE' && node.componentId) {
    hasil.componentId = node.componentId;
  }

  if (box && baseBox) {
    hasil.size = `${Math.round(box.width)}x${Math.round(box.height)}`;
    if (kedalaman > 0) {
      hasil.pos = `${Math.round(box.x - baseBox.x)},${Math.round(box.y - baseBox.y)}`;
    }
  }

  if (node.layoutMode && node.layoutMode !== 'NONE') {
    hasil.layout = node.layoutMode;
    if (node.itemSpacing) hasil.gap = node.itemSpacing;
    if (node.primaryAxisAlignItems) hasil.alignMain = node.primaryAxisAlignItems;
    if (node.counterAxisAlignItems) hasil.alignCross = node.counterAxisAlignItems;
  }

  if (node.paddingTop || node.paddingRight || node.paddingBottom || node.paddingLeft) {
    hasil.padding = [
      Math.round(node.paddingTop || 0),
      Math.round(node.paddingRight || 0),
      Math.round(node.paddingBottom || 0),
      Math.round(node.paddingLeft || 0)
    ];
  }

  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) {
    hasil.radius = Math.round(node.cornerRadius);
  } else if (Array.isArray(node.rectangleCornerRadii)) {
    hasil.radius = node.rectangleCornerRadii.map((r) => Math.round(r));
  }

  const fills = ekstrakFills(node.fills);
  if (fills.length > 0) hasil.fills = fills;

  const strokes = ekstrakFills(node.strokes);
  if (strokes.length > 0) {
    hasil.border = `${node.strokeWeight || 1}px ${strokes[0]}`;
  }

  if (Array.isArray(node.effects)) {
    const shadow = node.effects.find((e) => e.visible !== false && e.type === 'DROP_SHADOW');
    if (shadow && shadow.color) {
      hasil.shadow = `${Math.round(shadow.offset?.x || 0)}px ${Math.round(shadow.offset?.y || 0)}px ${Math.round(shadow.radius || 0)}px ${rgbKeHex(shadow.color)}`;
    }
  }

  if (typeof node.opacity === 'number' && node.opacity < 0.99) {
    hasil.opacity = Number(node.opacity.toFixed(2));
  }

  if (node.transitionNodeID) {
    hasil.navigasiKeNodeId = node.transitionNodeID;
  }

  if ((node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION') && Array.isArray(node.fillGeometry) && node.fillGeometry.length > 0) {
    hasil.svgPaths = node.fillGeometry.map((g) => g.path).filter(Boolean).slice(0, 4);
  }

  if (node.type === 'TEXT') {
    hasil.text = node.characters;
    if (node.style?.fontFamily) hasil.font = node.style.fontFamily;
    if (node.style?.fontSize) hasil.fontSize = Math.round(node.style.fontSize);
    if (node.style?.fontWeight) hasil.fontWeight = node.style.fontWeight;
    if (node.style?.lineHeightPx) hasil.lineHeight = Math.round(node.style.lineHeightPx);
    if (node.style?.textAlignHorizontal) hasil.textAlign = node.style.textAlignHorizontal;
  }

  if (Array.isArray(node.children) && node.children.length > 0) {
    const anak = node.children
      .map((c) => ringkasNodeUntukKode(c, baseBox, kedalaman + 1))
      .filter(Boolean);
    if (anak.length > 0) hasil.children = anak;
  }

  return hasil;
}

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
    lihat_folder: ({ sub_folder = '' } = {}) => {
      const targetDir = path.join(WORKSPACE, sub_folder);
      if (!fs.existsSync(targetDir)) return `Folder '${sub_folder}' belum ada di workspace.`;
      const files = fs.readdirSync(targetDir);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Mengecek isi workspace/${sub_folder}` });
      return files.length > 0 ? files.join(', ') : `Folder workspace/${sub_folder} masih kosong.`;
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
    baca_file: async ({ nama_file }) => {
      if (fileSudahDibaca.has(nama_file)) {
        return `Catatan: ${nama_file} sudah dibaca. Langsung lanjutkan keputusan.`;
      }
      const filePath = path.join(WORKSPACE, nama_file);
      if (!fs.existsSync(filePath)) return 'Error: File tidak ditemukan.';
      fileSudahDibaca.add(nama_file);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membaca ${nama_file}` });

      const ext = path.extname(nama_file).toLowerCase();
      if (ext === '.xlsx' || ext === '.xls') {
        const wb = XLSX.readFile(filePath);
        return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).slice(0, 4500);
      }

      if (ext === '.docx') {
        const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
        const xml = await zip.file('word/document.xml')?.async('string');
        if (!xml) return 'Error: Isi Word tidak terbaca.';
        const teks = xml.replace(/<\/w:p>/g, '\n').replace(/<[^>]+>/g, '').replace(/\n{2,}/g, '\n').trim();
        return teks.slice(0, 4500);
      }

      if (ext === '.pptx') {
        const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
        const slides = Object.keys(zip.files)
          .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
          .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
        let hasil = '';
        for (const s of slides) {
          const xml = await zip.file(s).async('string');
          const teksSlide = xml.replace(/<\/a:p>/g, ' | ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          hasil += `Slide ${s.match(/\d+/)[0]}: ${teksSlide}\n`;
        }
        return hasil.slice(0, 4500);
      }

      const isi = fs.readFileSync(filePath, 'utf-8').replace(/^\s*[\r\n]/gm, '');
      return isi.length > 4500 ? isi.slice(0, 4500) + '\n/* ...dipotong... */' : isi;
    },
    bedah_figma_json: ({ nama_file_sumber = 'Genius-app.json', nama_file_output = 'peta-desain.json' }) => {
      const srcPath = path.join(WORKSPACE, path.basename(nama_file_sumber));
      if (!fs.existsSync(srcPath)) {
        return `Error: File '${nama_file_sumber}' tidak ditemukan di folder workspace.`;
      }

      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membedah struktur Figma per halaman dari ${nama_file_sumber}...` });
      try {
        const rawJson = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
        const hasilBedah = ekstrakRingkasanFigma(rawJson);
        const outName = path.basename(nama_file_output || 'peta-desain.json');
        const outPath = path.join(WORKSPACE, outName);
        fs.writeFileSync(outPath, JSON.stringify(hasilBedah, null, 2), 'utf-8');

        const ringkasChat = {
          status: `Sukses menyimpan peta desain per halaman ke workspace/${outName}`,
          totalHalamanUI: hasilBedah.totalHalamanUI,
          totalLayarSemuaHalaman: hasilBedah.totalLayarSemuaHalaman,
          fileAssetLokalTersedia: hasilBedah.fileAssetLokalTersedia,
          jumlahKomponenDiAssets: hasilBedah.komponenDiHalamanAssets.length,
          paletWarnaUtama: hasilBedah.paletWarnaUtama.slice(0, 12),
          tipografiUtama: hasilBedah.tipografiUtama.slice(0, 8),
          daftarPerHalaman: hasilBedah.strukturPerHalaman.map((h) => ({
            namaHalamanFigma: h.namaHalamanFigma,
            jumlahLayar: h.jumlahLayar,
            namaLayar: h.daftarLayar.map((l) => `${l.namaLayar} (${l.ukuran || '-'})`)
          }))
        };
        return JSON.stringify(ringkasChat, null, 2);
      } catch (err) {
        return `Error saat parsing JSON Figma: ${err.message}`;
      }
    },
    ambil_detail_layar_figma: ({ nama_file_sumber = 'Genius-app.json', nama_halaman_figma = '', kata_kunci_layar = '' }) => {
      const srcPath = path.join(WORKSPACE, path.basename(nama_file_sumber));
      if (!fs.existsSync(srcPath)) return `Error: File '${nama_file_sumber}' tidak ditemukan.`;

      const labelCari = nama_halaman_figma || kata_kunci_layar || 'semua';
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Mengambil detail UI/UX '${labelCari}'...` });

      const rawJson = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
      const pages = Array.isArray(rawJson?.document?.children)
        ? rawJson.document.children
        : [{ name: 'Default', children: Array.isArray(rawJson) ? rawJson : Object.values(rawJson || {}) }];

      const filterPage = String(nama_halaman_figma || '').toLowerCase().trim();
      const filterLayar = String(kata_kunci_layar || '').toLowerCase().trim();
      const cocok = [];

      for (const page of pages) {
        const pageName = String(page.name || '');
        if (filterPage && !pageName.toLowerCase().includes(filterPage)) continue;

        function cari(node, kedalaman = 0) {
          if (!node || typeof node !== 'object' || cocok.length >= 6) return;
          const w = node.absoluteBoundingBox?.width ?? node.width ?? 0;
          const h = node.absoluteBoundingBox?.height ?? node.height ?? 0;
          const adalahFrame = (node.type === 'FRAME' || node.type === 'COMPONENT') && (kedalaman <= 1 || (w >= 300 && h >= 500));

          if (adalahFrame) {
            const namaCocok = !filterLayar || String(node.name || '').toLowerCase().includes(filterLayar);
            if (namaCocok) {
              cocok.push({
                halamanFigma: pageName,
                strukturUI: ringkasNodeUntukKode(node)
              });
              return;
            }
          }
          if (Array.isArray(node.children)) node.children.forEach((c) => cari(c, kedalaman + 1));
        }

        if (Array.isArray(page.children)) page.children.forEach((c) => cari(c, 0));
      }

      if (cocok.length === 0) {
        return `Tidak ditemukan frame layar untuk halaman '${nama_halaman_figma}' dengan kata kunci '${kata_kunci_layar}'.`;
      }

      const hasilAkhir = {
        fileAssetLokalTersedia: daftarFileAssetLokal(),
        jumlahLayarDiambil: cocok.length,
        layar: cocok
      };
      return JSON.stringify(hasilAkhir, null, 2).slice(0, 22000);
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
    buat_word: async ({ nama_file, judul_dokumen, bagian }) => {
      const namaFix = nama_file.endsWith('.docx') ? nama_file : `${nama_file}.docx`;
      const filePath = path.join(WORKSPACE, namaFix);
      const children = [];

      if (judul_dokumen) {
        children.push(new Paragraph({ text: judul_dokumen, heading: HeadingLevel.TITLE }));
      }
      for (const item of bagian || []) {
        if (item.subjudul) {
          children.push(new Paragraph({ text: item.subjudul, heading: HeadingLevel.HEADING_1 }));
        }
        if (item.isi) {
          for (const baris of String(item.isi).split('\n')) {
            if (baris.trim()) children.push(new Paragraph({ text: baris.trim() }));
          }
        }
      }

      const doc = new Document({ sections: [{ children }] });
      const buffer = await Packer.toBuffer(doc);
      fs.writeFileSync(filePath, buffer);
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membuat Word ${namaFix}` });
      return `Sukses membuat file Word ${namaFix}`;
    },
    buat_ppt: async ({ nama_file, slides }) => {
      const namaFix = nama_file.endsWith('.pptx') ? nama_file : `${nama_file}.pptx`;
      const filePath = path.join(WORKSPACE, namaFix);
      const pptx = new PptxGenJS();
      pptx.layout = 'LAYOUT_WIDE';

      for (const s of slides || []) {
        const slide = pptx.addSlide();
        slide.background = { color: '1E293B' };
        slide.addText(s.judul || 'Slide', {
          x: 0.6, y: 0.5, w: 12, h: 0.8,
          fontSize: 26, bold: true, color: 'F8FAFC'
        });
        const poinList = Array.isArray(s.poin) ? s.poin : [String(s.poin || '')];
        slide.addText(
          poinList.map((p) => ({ text: p, options: { bullet: true, breakLine: true } })),
          { x: 0.8, y: 1.5, w: 11.5, h: 5, fontSize: 16, color: 'CBD5E1', valign: 'top' }
        );
      }

      await pptx.writeFile({ fileName: filePath });
      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membuat PowerPoint ${namaFix}` });
      return `Sukses membuat file PowerPoint ${namaFix}`;
    },
    buat_pdf: async ({ nama_file, judul, isi_teks }) => {
      const namaFix = nama_file.endsWith('.pdf') ? nama_file : `${nama_file}.pdf`;
      const filePath = path.join(WORKSPACE, namaFix);

      await new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        if (judul) {
          doc.fontSize(20).font('Helvetica-Bold').text(judul, { align: 'left' }).moveDown();
        }
        doc.fontSize(11).font('Helvetica').text(String(isi_teks || ''), { lineGap: 4 });
        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
      });

      broadcast({ type: 'AKTIVITAS_TOOL', agent: namaAgent, aksi: `Membuat PDF ${namaFix}` });
      return `Sukses membuat file PDF ${namaFix}`;
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
      description: 'Melihat daftar file di folder workspace atau subfolder di dalamnya (misal sub_folder: "app/assets").',
      parameters: { type: 'object', properties: { sub_folder: { type: 'string' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tulis_file',
      description: 'Membuat file baru (HTML, CSS, JS, JSON, Markdown) di workspace.',
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
      description: 'Membaca isi file di workspace (.docx, .pptx, .xlsx, .xls, JSON, atau teks; cukup 1x per file, maksimal 4500 karakter).',
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
      name: 'bedah_figma_json',
      description: 'Membedah file JSON Figma di workspace menjadi peta-desain.json yang terkelompok per halaman Figma (Login, Home, Top Up, dll), lengkap dengan daftar komponen di halaman Assets dan file asset lokal di workspace/app/assets.',
      parameters: {
        type: 'object',
        properties: {
          nama_file_sumber: { type: 'string', description: 'Nama file JSON Figma di workspace, default: Genius-app.json' },
          nama_file_output: { type: 'string', description: 'Nama file output ringkasan, default: peta-desain.json' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ambil_detail_layar_figma',
      description: 'Mengambil detail lengkap struktur UI/UX (ukuran, koordinat, padding, gap, warna hex/gradient, border, shadow, vector SVG paths, nama komponen asset, dan navigasi prototype) untuk halaman Figma tertentu atau layar tertentu.',
      parameters: {
        type: 'object',
        properties: {
          nama_file_sumber: { type: 'string', description: 'Nama file JSON Figma di workspace, default: Genius-app.json' },
          nama_halaman_figma: { type: 'string', description: 'Nama halaman Figma, misalnya: Login, Home, Top Up, PAYMENT METHOD NON PROTOTYPE, Search, Upload, atau Profil' },
          kata_kunci_layar: { type: 'string', description: 'Opsional: filter nama frame layar spesifik di dalam halaman tersebut' }
        }
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
      name: 'buat_word',
      description: 'Membuat file dokumen Microsoft Word (.docx) di workspace.',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          judul_dokumen: { type: 'string' },
          bagian: {
            type: 'array',
            items: {
              type: 'object',
              properties: { subjudul: { type: 'string' }, isi: { type: 'string' } }
            }
          }
        },
        required: ['nama_file', 'bagian']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buat_ppt',
      description: 'Membuat file presentasi PowerPoint (.pptx) di workspace.',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                judul: { type: 'string' },
                poin: { type: 'array', items: { type: 'string' } }
              }
            }
          }
        },
        required: ['nama_file', 'slides']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'buat_pdf',
      description: 'Membuat file dokumen PDF (.pdf) di workspace.',
      parameters: {
        type: 'object',
        properties: {
          nama_file: { type: 'string' },
          judul: { type: 'string' },
          isi_teks: { type: 'string' }
        },
        required: ['nama_file', 'isi_teks']
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