// Вымышленные «фото» для демо-страницы — рисунки без чьих-либо данных. turn — на сколько градусов повёрнуто (по часовой).

type Pic = { w: number; h: number; body: string; base: number };

const PICS: Record<string, Pic> = {
  // Документ-образец пришёл «боком» (base 90): в окне просмотра его можно повернуть влево — и он встанет ровно
  document: {
    w: 800, h: 540, base: 90,
    body: `
      <rect width="800" height="540" rx="28" fill="#e9eef5"/>
      <rect x="24" y="24" width="752" height="492" rx="18" fill="#f8fafc" stroke="#b9c4d3" stroke-width="3"/>
      <text x="60" y="92" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#27415f">ДОКУМЕНТ · ОБРАЗЕЦ</text>
      <text x="60" y="130" font-family="Arial, sans-serif" font-size="20" fill="#6b7a8d">для проверки окна просмотра и поворота</text>
      <rect x="60" y="170" width="190" height="240" rx="12" fill="#d7e0ea"/>
      <circle cx="155" cy="250" r="46" fill="#b8c6d6"/>
      <rect x="95" y="310" width="120" height="80" rx="40" fill="#b8c6d6"/>
      ${[0, 1, 2, 3, 4].map((i) => `<rect x="290" y="${180 + i * 46}" width="${420 - i * 40}" height="18" rx="9" fill="#cbd5e1"/>`).join("")}
      <text x="60" y="470" font-family="Courier New, monospace" font-size="22" fill="#94a3b8">0000 000000 · ОБРАЗЕЦ</text>`,
  },
  // Снимок экрана с прайсом
  screenshot: {
    w: 720, h: 900, base: 0,
    body: `
      <rect width="720" height="900" fill="#ffffff"/>
      <rect width="720" height="120" fill="#2f6bd8"/>
      <text x="40" y="76" font-family="Arial, sans-serif" font-size="36" font-weight="700" fill="#ffffff">Прайс · пример</text>
      ${["Консультация — 1 000 сом", "Диагностика — 1 500 сом", "Повторный приём — 800 сом"].map((t, i) =>
        `<text x="40" y="${200 + i * 60}" font-family="Arial, sans-serif" font-size="28" fill="#16202e">${t}</text>`).join("")}
      ${[0, 1, 2, 3, 4].map((i) => `<rect x="40" y="${420 + i * 70}" width="${620 - (i % 3) * 90}" height="22" rx="11" fill="#e2e6ec"/>`).join("")}`,
  },
};

export function photoSvg(name: string, turn: number): string | null {
  const p = PICS[name];
  if (!p) return null;
  const deg = (((p.base + turn) % 360) + 360) % 360;
  const side = deg === 90 || deg === 270;
  const W = side ? p.h : p.w;
  const H = side ? p.w : p.h;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <g transform="translate(${W / 2} ${H / 2}) rotate(${deg}) translate(${-p.w / 2} ${-p.h / 2})">${p.body}</g>
  </svg>`;
}
