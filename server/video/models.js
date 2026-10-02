import path from 'node:path';
import {
  pipeline, env, AutoTokenizer, AutoProcessor, RawImage,
  CLIPTextModelWithProjection, CLIPVisionModelWithProjection,
} from '@huggingface/transformers';
import { DATA, getSetting } from '../db.js';

// All models are open-weight and run locally on CPU via ONNX. Downloaded once, then cached.
env.cacheDir = path.join(DATA, 'models');

export const MODEL_IDS = {
  whisper: () => getSetting('whisperModel', 'Xenova/whisper-base'),
  clip: 'Xenova/clip-vit-base-patch32',
  text: 'Xenova/all-MiniLM-L6-v2',
};

const cache = new Map();
const once = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
};

export const getWhisper = () => {
  const id = MODEL_IDS.whisper();
  return once(`whisper:${id}`, () => pipeline('automatic-speech-recognition', id, { dtype: 'q8' }));
};
const getTextEmbedder = () => once('text', () => pipeline('feature-extraction', MODEL_IDS.text, { dtype: 'q8' }));
const getClip = () => once('clip', async () => ({
  tokenizer: await AutoTokenizer.from_pretrained(MODEL_IDS.clip),
  processor: await AutoProcessor.from_pretrained(MODEL_IDS.clip),
  text: await CLIPTextModelWithProjection.from_pretrained(MODEL_IDS.clip, { dtype: 'q8' }),
  vision: await CLIPVisionModelWithProjection.from_pretrained(MODEL_IDS.clip, { dtype: 'q8' }),
}));

const normalize = (v) => {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
};

export async function embedTexts(texts) {
  if (!texts.length) return [];
  const model = await getTextEmbedder();
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const t = await model(texts.slice(i, i + 32), { pooling: 'mean', normalize: true });
    out.push(...t.tolist().map((v) => Float32Array.from(v)));
  }
  return out;
}

export async function clipEmbedImages(files) {
  const clip = await getClip();
  const out = [];
  for (let i = 0; i < files.length; i += 8) {
    const imgs = await Promise.all(files.slice(i, i + 8).map((f) => RawImage.read(f)));
    const inputs = await clip.processor(imgs);
    const { image_embeds } = await clip.vision(inputs);
    out.push(...image_embeds.tolist().map(normalize));
  }
  return out;
}

export async function clipEmbedText(text) {
  const clip = await getClip();
  const inputs = clip.tokenizer([text], { padding: true, truncation: true });
  const { text_embeds } = await clip.text(inputs);
  return normalize(text_embeds.tolist()[0]);
}

export const cosine = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
