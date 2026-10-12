import { Resvg } from "@resvg/resvg-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The NFT image: an SVG drawn here and rasterized with resvg (no satori, no browser). Fonts are
 * vendored (DejaVu, permissive license, apps/api/assets/fonts) because the alpine image has no
 * system fonts and resvg renders no text without a font file.
 *
 * TestMyAgent palette (design brief 1.2): bg #0A0908, surface #141210, line #2A2722, accent #3FD17F,
 * accent facet #78E3A0, text #F4EDE2, muted #A2AAA1. The TMA wordmark is the 8-polygon mark of the
 * Brand Kit (viewBox 0 0 214 100).
 */
const TMA_WORDMARK = `<polygon points="0,0 58,0 58,24 0,24" fill="#3FD17F"/>
    <polygon points="18,29 40,29 40,100 18,100" fill="#3FD17F"/>
    <polygon points="63,0 85,0 85,100 63,100" fill="#3FD17F"/>
    <polygon points="90,0 103,0 103,70" fill="#3FD17F"/>
    <polygon points="103,0 116,0 103,70" fill="#78E3A0"/>
    <polygon points="121,0 143,0 143,100 121,100" fill="#3FD17F"/>
    <polygon points="148,100 181,0 181,66 170,100" fill="#3FD17F"/>
    <polygon points="181,0 214,100 192,100 181,66" fill="#78E3A0"/>`;

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
  <rect x="40" y="40" width="920" height="920" rx="36" fill="#141210" stroke="#2A2722" stroke-width="2"/>
  <g transform="translate(80 84) scale(0.6)">
    ${TMA_WORDMARK}
  </g>
  <rect x="226" y="88" width="2" height="48" fill="#35382F"/>
  <text x="248" y="126" font-family="DejaVu Sans" font-weight="bold" font-size="34" fill="#F4EDE2">testmyagent<tspan fill="#3FD17F">.com</tspan></text>
  <text x="920" y="128" text-anchor="end" font-family="DejaVu Sans Mono" font-size="22" fill="#3FD17F">RUN RESULT</text>
  <text x="80" y="250" font-family="DejaVu Sans Mono" font-size="26" fill="#A2AAA1">BENCHMARK</text>
  <text x="80" y="300" font-family="DejaVu Sans" font-weight="bold" font-size="44" fill="#F4EDE2">${esc(clip(input.benchmark, 30))}</text>
  <text x="80" y="600" font-family="DejaVu Sans" font-weight="bold" font-size="260" fill="#3FD17F">${score}</text>
  <text x="${96 + score.length * 172}" y="600" font-family="DejaVu Sans Mono" font-size="56" fill="#A2AAA1">/100</text>
  <rect x="80" y="640" width="840" height="14" rx="7" fill="#2A2722"/>
  <rect x="80" y="640" width="${bar}" height="14" rx="7" fill="#3FD17F"/>
  <text x="80" y="730" font-family="DejaVu Sans Mono" font-size="24" fill="#A2AAA1">AGENT</text>
  <text x="200" y="730" font-family="DejaVu Sans Mono" font-size="24" fill="#F4EDE2">${esc(clip(input.agent, 48))}</text>
  <text x="80" y="775" font-family="DejaVu Sans Mono" font-size="24" fill="#A2AAA1">MODEL</text>
  <text x="200" y="775" font-family="DejaVu Sans Mono" font-size="24" fill="#F4EDE2">${esc(clip(input.model, 48))}</text>
  <text x="80" y="820" font-family="DejaVu Sans Mono" font-size="24" fill="#A2AAA1">PROOF</text>
  <text x="200" y="820" font-family="DejaVu Sans Mono" font-size="24" fill="#3FD17F">${esc(hash)}</text>
  <text x="80" y="910" font-family="DejaVu Sans Mono" font-size="20" fill="#A2AAA1">Solana devnet · SAS run-result-v2 · non-transferable</text>
</svg>`;
}

export function renderNftPng(input: NftImageInput): Buffer {
  const resvg = new Resvg(nftSvg(input), {
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" },
    fitTo: { mode: "width", value: 1000 },
  });
  return resvg.render().asPng();
}
