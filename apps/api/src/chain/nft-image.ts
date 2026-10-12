import { Resvg } from "@resvg/resvg-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The NFT image: an SVG drawn here and rasterized with resvg (no satori, no browser). Fonts are
 * vendored (DejaVu, permissive license, apps/api/assets/fonts) because the alpine image has no
 * system fonts and resvg renders no text without a font file.
 *
 * ITERA palette (apps/web/src/style.css): bg #0A0908, panel #141210, accent #3FD17F,
 * on-dark green #62D996, text #F4EDE2, muted #8a8378.
 */
const FONT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../assets/fonts");
const FONT_FILES = [join(FONT_DIR, "DejaVuSans-Bold.ttf"), join(FONT_DIR, "DejaVuSansMono.ttf")];

export interface NftImageInput {
  scoreTotal: number;
  benchmark: string;
  agent: string;
  model: string;
  proofHash: string;
}

function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function nftSvg(input: NftImageInput): string {
  const score = String(Math.max(0, Math.min(100, Math.round(input.scoreTotal))));
  const bar = Math.round((Number(score) / 100) * 840);
  const hash = input.proofHash ? `${input.proofHash.slice(0, 16)}…${input.proofHash.slice(-8)}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000" viewBox="0 0 1000 1000">
  <rect width="1000" height="1000" fill="#0A0908"/>
  <rect x="40" y="40" width="920" height="920" rx="36" fill="#141210" stroke="#2a2721" stroke-width="2"/>
  <rect x="80" y="80" width="72" height="72" rx="18" fill="none" stroke="#3FD17F" stroke-width="3"/>
  <text x="116" y="132" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="44" fill="#3FD17F">i</text>
  <text x="176" y="128" font-family="DejaVu Sans" font-weight="bold" font-size="34" letter-spacing="6" fill="#F4EDE2">ITERA</text>
  <text x="920" y="128" text-anchor="end" font-family="DejaVu Sans Mono" font-size="22" fill="#62D996">AGENT PROOF</text>
  <text x="80" y="250" font-family="DejaVu Sans Mono" font-size="26" fill="#8a8378">BENCHMARK</text>
  <text x="80" y="300" font-family="DejaVu Sans" font-weight="bold" font-size="44" fill="#F4EDE2">${esc(clip(input.benchmark, 30))}</text>
  <text x="80" y="600" font-family="DejaVu Sans" font-weight="bold" font-size="260" fill="#3FD17F">${score}</text>
  <text x="${96 + score.length * 172}" y="600" font-family="DejaVu Sans Mono" font-size="56" fill="#8a8378">/100</text>
  <rect x="80" y="640" width="840" height="14" rx="7" fill="#2a2721"/>
  <rect x="80" y="640" width="${bar}" height="14" rx="7" fill="#3FD17F"/>
  <text x="80" y="730" font-family="DejaVu Sans Mono" font-size="24" fill="#8a8378">AGENT</text>
  <text x="200" y="730" font-family="DejaVu Sans Mono" font-size="24" fill="#F4EDE2">${esc(clip(input.agent, 48))}</text>
  <text x="80" y="775" font-family="DejaVu Sans Mono" font-size="24" fill="#8a8378">MODEL</text>
  <text x="200" y="775" font-family="DejaVu Sans Mono" font-size="24" fill="#F4EDE2">${esc(clip(input.model, 48))}</text>
  <text x="80" y="820" font-family="DejaVu Sans Mono" font-size="24" fill="#8a8378">PROOF</text>
  <text x="200" y="820" font-family="DejaVu Sans Mono" font-size="24" fill="#62D996">${esc(hash)}</text>
  <text x="80" y="910" font-family="DejaVu Sans Mono" font-size="20" fill="#8a8378">Solana devnet · SAS run-result-v2 · non-transferable</text>
</svg>`;
}

export function renderNftPng(input: NftImageInput): Buffer {
  const resvg = new Resvg(nftSvg(input), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "width", value: 1000 },
  });
  return resvg.render().asPng();
}
