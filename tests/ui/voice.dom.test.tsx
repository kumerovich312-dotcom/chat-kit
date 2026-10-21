// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoicePlayer } from "../../src/ui/VoicePlayer.js";

// Голосовое: длина для точки и перемотки — та, по которой играет браузер. Разбор файла для волны (Opera с декодером
// Windows) может дать меньше настоящей — 1:15 вместо 1:22, и точка доезжала до конца раньше голоса.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubDecode(seconds: number) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(16))));
  class FakeOffline {
    decodeAudioData() {
      return Promise.resolve({ duration: seconds, getChannelData: () => new Float32Array(4410) });
    }
  }
  vi.stubGlobal("OfflineAudioContext", FakeOffline);
}

describe("VoicePlayer", () => {
  it("берёт длину браузера, когда она известна, а не длину из разбора файла", async () => {
    stubDecode(75);
    const { container } = render(<VoicePlayer id="v1" src="/voice-1.mp3" sizeLabel="643 КБ" />);
    const slider = screen.getByRole("slider");
    await vi.waitFor(() => expect(slider.getAttribute("aria-valuemax")).toBe("75"));
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 82 });
    await act(async () => { fireEvent(audio, new Event("loadedmetadata")); });
    expect(slider.getAttribute("aria-valuemax")).toBe("82");
  });

  it("уточнённая браузером длина по ходу воспроизведения тоже идёт в точку", async () => {
    stubDecode(75);
    const { container } = render(<VoicePlayer id="v2" src="/voice-2.mp3" />);
    const slider = screen.getByRole("slider");
    await vi.waitFor(() => expect(slider.getAttribute("aria-valuemax")).toBe("75"));
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 82 });
    await act(async () => { fireEvent(audio, new Event("durationchange")); });
    expect(slider.getAttribute("aria-valuemax")).toBe("82");
  });

  it("нажали «слушать» раньше, чем дорисовалась волна: разбор файла не затирает длину браузера", async () => {
    let finish: (v: unknown) => void = () => {};
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(16))));
    class SlowOffline {
      decodeAudioData() {
        return new Promise((r) => { finish = r; });
      }
    }
    vi.stubGlobal("OfflineAudioContext", SlowOffline);
    const { container } = render(<VoicePlayer id="v4" src="/voice-4.mp3" />);
    const slider = screen.getByRole("slider");
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => 82 });
    await act(async () => { fireEvent(audio, new Event("loadedmetadata")); });
    expect(slider.getAttribute("aria-valuemax")).toBe("82");
    await vi.waitFor(() => expect(typeof finish).toBe("function"));
    await act(async () => { finish({ duration: 75, getChannelData: () => new Float32Array(4410) }); await Promise.resolve(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(slider.getAttribute("aria-valuemax")).toBe("82");
  });

  it("полоски волны стоят на всю её ширину — закраска доходит до точки, а не отстаёт от неё", () => {
    // Точка едет по всей ширине волны (left: f * 100%). Раньше 36 полосок стояли слева (около 178 px из 294),
    // и точка обгоняла закраску почти на треть
    const css = readFileSync("src/ui/styles.css", "utf8");
    const rule = /\.ck-wave \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/justify-content:\s*space-between/);
    // Расклад «полоски на всю ширину»: последняя закрашенная полоска кончается не дальше шага одной полоски от точки
    const BARS = 36, BAR = 3;
    for (const width of [178, 250, 294, 420]) {
      const step = (width - BAR) / (BARS - 1);
      for (let f = 0.05; f < 1; f += 0.05) {
        const done = Array.from({ length: BARS }, (_, i) => i).filter((i) => (i + 0.5) / BARS <= f);
        const end = done.length ? done.at(-1)! * step + BAR : 0;
        expect(Math.abs(f * width - end)).toBeLessThanOrEqual(step + BAR);
      }
    }
  });

  it("бесконечная или пустая длина браузера не затирает длину из разбора", async () => {
    stubDecode(75);
    const { container } = render(<VoicePlayer id="v3" src="/voice-3.mp3" />);
    const slider = screen.getByRole("slider");
    await vi.waitFor(() => expect(slider.getAttribute("aria-valuemax")).toBe("75"));
    const audio = container.querySelector("audio")!;
    Object.defineProperty(audio, "duration", { configurable: true, get: () => Infinity });
    await act(async () => { fireEvent(audio, new Event("loadedmetadata")); });
    expect(slider.getAttribute("aria-valuemax")).toBe("75");
  });
});
