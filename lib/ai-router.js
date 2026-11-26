import OpenAI from 'openai';
import { bacaUserKeys } from './keys.js';
import { buatAlatKantor, daftarSkemaTools } from './tools.js';

const DAFTAR_OTAK = [
  {
    nama: 'Groq (Llama 3.3 70B)',
    provider: 'groq',
    get apiKey() { return bacaUserKeys().groq; },
    baseURL: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    vision: false
  },
  {
    nama: 'Gemini 2.5 Flash',
    provider: 'gemini',
    get apiKey() { return bacaUserKeys().gemini; },
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash',
    vision: true
  },
  {
    nama: 'Gemini Flash (Latest)',
    provider: 'gemini',
    get apiKey() { return bacaUserKeys().gemini; },
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-flash-latest',
    vision: true
  },
  {
    nama: 'Gemini Flash Lite',
    provider: 'gemini',
    get apiKey() { return bacaUserKeys().gemini; },
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-flash-lite-latest',
    vision: true
  },
  {
    nama: 'OpenRouter (Free)',
    provider: 'openrouter',
    get apiKey() { return bacaUserKeys().openrouter; },
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'openrouter/free',
    vision: false
  }
];

let indexOtak = 0;

function cekJikaDibatalkan(signal) {
  if (signal?.aborted) {
    throw new Error('ABORTED_BY_USER');
  }
}

function ambilOtakAktif(butuhVision = false) {
  const valid = DAFTAR_OTAK.filter(
    (o) => o.apiKey && !o.apiKey.startsWith('PASTE_') && !o.apiKey.startsWith('OPSIONAL_')
  );
  if (valid.length === 0) {
    throw new Error('API Key belum dipasang. Klik tombol "Pasang API Key" di pojok kanan atas.');
  }
  if (butuhVision) {
    const daftarVision = valid.filter((o) => o.vision);
    if (daftarVision.length === 0) {
      throw new Error('Belum ada API Key dengan fitur Vision (Gemini) yang aktif. Silakan pasang di menu API Keys.');
    }
    return daftarVision[indexOtak % daftarVision.length];
  }
  return valid[indexOtak % valid.length];
}

function pangkasMemoriJikaBesar(memory, batasKarakter = 18000) {
  const total = () => memory.reduce((acc, m) => acc + JSON.stringify(m).length, 0);
  for (let i = 2; i < memory.length - 1; i++) {
    if (total() <= batasKarakter) break;
    if (memory[i].role === 'tool' && memory[i].content.length > 350) {
      memory[i].content = '[Hasil baca file sebelumnya diringkas otomatis untuk menghemat token]';
    }
  }
}

function siapkanPesanUntukOtak(messages, otak) {
  const isGemini3OrNewer =
    otak.provider === 'gemini' &&
    (otak.model.includes('gemini-3') || otak.model.includes('gemini-4') || otak.model.includes('flash-latest') || otak.model.includes('pro-latest'));

  if (!isGemini3OrNewer) return messages;

  const hasil = [];
  for (const m of messages) {
    const punyaSignature =
      Array.isArray(m.tool_calls) &&
      m.tool_calls.some((tc) => tc.extra_content?.google?.thought_signature);

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0 && !punyaSignature) {
      const daftarAksi = m.tool_calls.map((tc) => `${tc.function.name}(${tc.function.arguments})`).join(', ');
      hasil.push({ role: 'assistant', content: `[Menjalankan alat: ${daftarAksi}]` });
    } else if (m.role === 'tool') {
      const prev = hasil[hasil.length - 1];
      if (prev && prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
        hasil.push(m);
      } else {
        hasil.push({ role: 'user', content: `[Hasil alat sebelumnya]: ${m.content}` });
      }
    } else {
      hasil.push(m);
    }
  }
  return hasil;
}

async function panggilAIDenganFailover(params, butuhVision, broadcast, signal, maksimalCoba = 10) {
  for (let i = 1; i <= maksimalCoba; i++) {
    cekJikaDibatalkan(signal);

    const otak = ambilOtakAktif(butuhVision);
    broadcast({ type: 'OTAK_AKTIF', nama: otak.nama });

    const batas = otak.provider === 'gemini' ? 45000 : 17000;
    pangkasMemoriJikaBesar(params.messages, batas);
    const messagesSiap = siapkanPesanUntukOtak(params.messages, otak);
    const client = new OpenAI({ apiKey: otak.apiKey, baseURL: otak.baseURL });

    try {
      return await client.chat.completions.create(
        { ...params, messages: messagesSiap, model: otak.model },
        { signal }
      );
    } catch (err) {
      if (signal?.aborted || err.name === 'AbortError' || err.name === 'APIUserAbortError') {
        throw new Error('ABORTED_BY_USER');
      }
      const status = err.status || 500;
      console.log(`   [FAILOVER ${status}] ${otak.nama} kendala: ${err.message}`);
      indexOtak++;
      const otakBaru = ambilOtakAktif(butuhVision);
      broadcast({
        type: 'AKTIVITAS_TOOL',
        agent: 'Manager',
        aksi: `Otak ${otak.nama} limit/error (${status}), pindah ke ${otakBaru.nama}...`
      });
      await new Promise((r) => setTimeout(r, status === 503 ? 3500 : 1500));
    }
  }
  throw new Error('Semua otak AI sedang mencapai batas kuota. Tunggu 1 menit lalu coba lagi.');
}

export async function panggilKaryawan({
  namaAgent,
  systemPrompt,
  userContent,
  izinTools,
  butuhVision = false,
  maxSteps = 7,
  stateToken,
  broadcast,
  signal
}) {
  const toolsKaryawan =
    izinTools.length > 0
      ? daftarSkemaTools.filter((t) => izinTools.includes(t.function.name))
      : undefined;

  const alat = buatAlatKantor(namaAgent, new Set(), broadcast, signal);
  const memory = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent }
  ];

  for (let step = 1; step <= maxSteps; step++) {
    cekJikaDibatalkan(signal);

    const reqPayload = { messages: memory };
    if (toolsKaryawan) {
      reqPayload.tools = toolsKaryawan;
      reqPayload.tool_choice = 'auto';
    }

    const response = await panggilAIDenganFailover(reqPayload, butuhVision, broadcast, signal);

    if (response.usage) {
      stateToken.total += response.usage.total_tokens || 0;
      broadcast({ type: 'TOKEN_UPDATE', totalToken: stateToken.total });
    }

    const pesanAsisten = response.choices[0].message;
    memory.push(structuredClone(pesanAsisten));

    if (pesanAsisten.tool_calls && pesanAsisten.tool_calls.length > 0) {
      for (const call of pesanAsisten.tool_calls) {
        cekJikaDibatalkan(signal);
        const namaFungsi = call.function.name;
        let output = '';
        try {
          const args = JSON.parse(call.function.arguments || '{}');
          output = alat[namaFungsi] ? await alat[namaFungsi](args) : 'Tool tidak dikenal';
        } catch (e) {
          if (signal?.aborted || e.message === 'ABORTED_BY_USER') throw new Error('ABORTED_BY_USER');
          output = `Error: ${e.message || 'Argumen JSON tidak valid.'}`;
        }
        memory.push({ role: 'tool', tool_call_id: call.id, content: output });
      }
    } else {
      return pesanAsisten.content || 'Selesai.';
    }
  }
  return 'Pekerjaan selesai (batas langkah tercapai).';
}