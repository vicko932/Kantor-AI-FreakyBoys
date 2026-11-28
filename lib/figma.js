export async function ambilStrukturFigma(fileKey, figmaToken) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}`, {
    headers: { 'X-Figma-Token': figmaToken }
  });
  if (!res.ok) throw new Error(`Figma API Error: ${res.status}`);
  const data = await res.json();

  const ringkasanHalaman = [];

  function ekstrakTeks(node, hasil = []) {
    if (node.type === 'TEXT' && node.characters) hasil.push(node.characters);
    if (node.children) node.children.forEach((c) => ekstrakTeks(c, hasil));
    return hasil;
  }

  function telusuriNode(node, namaPage) {
    if (node.type === 'FRAME' || node.type === 'COMPONENT') {
      ringkasanHalaman.push({
        page: namaPage,
        id: node.id,
        namaLayar: node.name,
        ukuran: node.absoluteBoundingBox
          ? `${Math.round(node.absoluteBoundingBox.width)}x${Math.round(node.absoluteBoundingBox.height)}`
          : null,
        layout: node.layoutMode || 'NONE',
        navigasiKeNodeId: node.transitionNodeID || null,
        teksDiDalamnya: ekstrakTeks(node)
      });
    }
    if (node.children) {
      node.children.forEach((child) => telusuriNode(child, namaPage));
    }
  }

  data.document.children.forEach((page) => telusuriNode(page, page.name));
  return { namaProyek: data.name, totalLayar: ringkasanHalaman.length, daftarLayar: ringkasanHalaman };
}