import path from 'path';
import * as XLSXModule from 'xlsx';
import JSZipModule from 'jszip';
import sharp from 'sharp';

const XLSX = XLSXModule.default || XLSXModule;
const JSZip = JSZipModule.default || JSZipModule;

export async function ekstrakIsiFile(namaFile, buffer) {
  const ext = path.extname(namaFile).toLowerCase();

  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    let hasil = `[FILE EXCEL: ${namaFile}]\n`;
    wb.SheetNames.slice(0, 4).forEach((sheetName) => {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[sheetName]);
      const baris = csv.split('\n').slice(0, 80).join('\n');
      hasil += `--- Sheet: ${sheetName} ---\n${baris}\n`;
    });
    return { tipe: 'teks', konten: hasil.slice(0, 9000) };
  }

  if (ext === '.docx') {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file('word/document.xml')?.async('string');
    if (!docXml) return { tipe: 'teks', konten: `[Word ${namaFile}: isi tidak terbaca]` };
    const teks = docXml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
    return { tipe: 'teks', konten: `[FILE WORD: ${namaFile}]\n${teks.slice(0, 9000)}` };
  }

  if (ext === '.pptx') {
    const zip = await JSZip.loadAsync(buffer);
    const slideFiles = Object.keys(zip.files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));

    let hasil = `[FILE POWERPOINT: ${namaFile} (${slideFiles.length} slide)]\n`;
    for (const sFile of slideFiles.slice(0, 20)) {
      const xml = await zip.file(sFile).async('string');
      const teksSlide = xml
        .replace(/<\/a:p>/g, ' | ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const nomor = sFile.match(/\d+/)[0];
      hasil += `Slide ${nomor}: ${teksSlide}\n`;
    }
    return { tipe: 'teks', konten: hasil.slice(0, 9000) };
  }

  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    let dimensiTeks = '';
    try {
      const meta = await sharp(buffer).rotate().metadata();
      if (meta.width && meta.height) {
        dimensiTeks = ` (Dimensi: ${meta.width}x${meta.height}px)`;
      }
    } catch (e) {}

    return {
      tipe: 'gambar',
      nama: namaFile,
      infoTeks: `[GAMBAR LAMPIRAN: ${namaFile}${dimensiTeks}]`,
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
    };
  }

  return {
    tipe: 'teks',
    konten: `[FILE: ${namaFile}]\n${buffer.toString('utf-8').slice(0, 9000)}`
  };
}