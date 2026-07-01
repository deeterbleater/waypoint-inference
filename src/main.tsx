import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Download,
  ImagePlus,
  Loader2,
  Lock,
  LogOut,
  MousePointer2,
  Play,
  RotateCcw,
  Shield,
  Square,
} from "lucide-react";
import "./styles.css";

const PORTAL_PASSWORD = "waypoint";
const SESSION_KEY = "waypoint.portal.authed";
const DRIVE_STEP_PAUSE_MS = 300;

type Health = {
  ok: boolean;
  engine_loaded: boolean;
  seeded: boolean;
  device: string;
  dtype: string;
  torch: string;
  auth_required: boolean;
  cuda: {
    available: boolean;
    name?: string;
    memory_allocated_mb?: number;
    memory_reserved_mb?: number;
  };
};

type GenerateResponse = {
  ok: boolean;
  frames: string[];
  frame_mime?: string;
  frame_count: number;
  steps: number;
  step_seconds: number[];
  total_seconds: number;
  error?: string;
};

type StreamEvent =
  | {
      ok: true;
      type: "frame_batch";
      frames: string[];
      frame_mime?: string;
      frame_count: number;
      step: number;
      steps: number;
      step_seconds: number;
      total_seconds: number;
    }
  | {
      ok: true;
      type: "done";
      steps: number;
      total_seconds: number;
    }
  | {
      ok: false;
      type: "error";
      error: string;
    };

type LogEntry = {
  id: number;
  label: string;
  detail: string;
  kind: "ok" | "warn" | "error";
};

const keyButtons = [
  { code: 87, label: "W", icon: ArrowUp },
  { code: 65, label: "A", icon: ArrowLeft },
  { code: 83, label: "S", icon: ArrowDown },
  { code: 68, label: "D", icon: ArrowRight },
  { code: 32, label: "Space", icon: Square },
];

function App() {
  const [authed, setAuthed] = useState(() => localStorage.getItem(SESSION_KEY) === "true");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [driveFrames, setDriveFrames] = useState(0);
  const [steps, setSteps] = useState(1);
  const [reset, setReset] = useState(true);
  const [buttons, setButtons] = useState<number[]>([87]);
  const [mouseX, setMouseX] = useState(0.02);
  const [mouseY, setMouseY] = useState(0);
  const [seedImage, setSeedImage] = useState<string | null>(null);
  const [seedName, setSeedName] = useState("");
  const [frames, setFrames] = useState<string[]>([]);
  const [frameMime, setFrameMime] = useState("image/png");
  const [displayFrame, setDisplayFrame] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<GenerateResponse | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const controlsRef = useRef({ buttons, mouseX, mouseY, seedImage, reset });

  const activeButtonLabels = useMemo(
    () => keyButtons.filter((item) => buttons.includes(item.code)).map((item) => item.label),
    [buttons],
  );

  useEffect(() => {
    if (!authed) return;
    void fetchHealth();
    const timer = window.setInterval(fetchHealth, 12000);
    return () => window.clearInterval(timer);
  }, [authed]);

  useEffect(() => {
    controlsRef.current = { buttons, mouseX, mouseY, seedImage, reset };
  }, [buttons, mouseX, mouseY, seedImage, reset]);

  useEffect(() => {
    if (!authed) return;

    const codes = new Set(keyButtons.map((item) => item.code));
    const updateKey = (event: KeyboardEvent, pressed: boolean) => {
      if (!codes.has(event.keyCode)) return;
      const target = event.target as HTMLElement | null;
      if (target?.tagName === "INPUT") return;
      event.preventDefault();
      setButtons((current) => {
        const has = current.includes(event.keyCode);
        if (pressed && !has) return [...current, event.keyCode];
        if (!pressed && has) return current.filter((item) => item !== event.keyCode);
        return current;
      });
    };

    const down = (event: KeyboardEvent) => updateKey(event, true);
    const up = (event: KeyboardEvent) => updateKey(event, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [authed]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  function addLog(label: string, detail: string, kind: LogEntry["kind"] = "ok") {
    setLogs((current) => [{ id: Date.now(), label, detail, kind }, ...current].slice(0, 8));
  }

  function unlock(event: FormEvent) {
    event.preventDefault();
    if (password === PORTAL_PASSWORD) {
      localStorage.setItem(SESSION_KEY, "true");
      setAuthed(true);
      setPasswordError("");
      return;
    }
    setPasswordError("No.");
  }

  function lock() {
    stopDrive();
    localStorage.removeItem(SESSION_KEY);
    setAuthed(false);
    setPassword("");
  }

  async function callApi<T>(action: string, body?: unknown): Promise<T> {
    const response = await fetch(`/api/waypoint?action=${action}`, {
      method: body ? "POST" : "GET",
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `${action} failed`);
    }
    return payload as T;
  }

  async function fetchHealth() {
    try {
      const payload = await callApi<Health>("health");
      setHealth(payload);
      setHealthError("");
    } catch (error) {
      setHealthError(error instanceof Error ? error.message : "health check failed");
    }
  }

  async function generate() {
    setBusy(true);
    try {
      const payload = await callApi<GenerateResponse>("generate", {
        steps,
        reset,
        button: buttons,
        mouse: [mouseX, mouseY],
        seed_image: seedImage,
      });
      setFrames(payload.frames);
      setFrameMime(payload.frame_mime || "image/png");
      setDisplayFrame(payload.frames[0] || null);
      setLastRun(payload);
      setReset(false);
      addLog("generate", `${payload.frame_count} frames in ${payload.total_seconds}s`);
      void fetchHealth();
    } catch (error) {
      const message = error instanceof Error ? error.message : "generation failed";
      addLog("generate", message, "error");
    } finally {
      setBusy(false);
    }
  }

  async function readStream(response: Response) {
    if (!response.body) {
      throw new Error("stream response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as StreamEvent;
        if (!event.ok) {
          throw new Error(event.error);
        }
        if (event.type === "frame_batch") {
          setFrames(event.frames);
          setFrameMime(event.frame_mime || "image/jpeg");
          animateFrames(event.frames);
          setDriveFrames((current) => current + event.frame_count);
          setLastRun({
            ok: true,
            frames: event.frames,
            frame_mime: event.frame_mime || "image/jpeg",
            frame_count: event.frame_count,
            steps: event.steps,
            step_seconds: [event.step_seconds],
            total_seconds: event.total_seconds,
          });
        }
      }
    }
  }

  async function streamStep(controller: AbortController, firstStep: boolean) {
    const current = controlsRef.current;
    const response = await fetch("/api/waypoint?action=stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: 1,
        format: "jpeg",
        reset: firstStep ? current.reset : false,
        button: current.buttons,
        mouse: [current.mouseX, current.mouseY],
        seed_image: firstStep ? current.seedImage : undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "stream failed");
    }

    await readStream(response);
  }

  async function startDrive() {
    if (streaming || busy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setStreaming(true);
    setDriveFrames(0);
    addLog("drive", "started");

    let firstStep = true;
    try {
      while (!controller.signal.aborted) {
        await streamStep(controller, firstStep);
        firstStep = false;
        setReset(false);
        await new Promise((resolve) => window.setTimeout(resolve, DRIVE_STEP_PAUSE_MS));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        addLog("drive", error instanceof Error ? error.message : "stream failed", "error");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      void fetchHealth();
    }
  }

  function stopDrive() {
    abortRef.current?.abort();
    if (streaming) {
      addLog("drive", "stopped", "warn");
    }
  }

  function animateFrames(nextFrames: string[]) {
    nextFrames.forEach((frame, index) => {
      window.setTimeout(() => setDisplayFrame(frame), Math.round(index * (1000 / 60)));
    });
  }

  async function resetWorld() {
    setBusy(true);
    try {
      await callApi("reset", {});
      setReset(true);
      setFrames([]);
      setDisplayFrame(null);
      setLastRun(null);
      addLog("reset", "state cleared");
      void fetchHealth();
    } catch (error) {
      addLog("reset", error instanceof Error ? error.message : "reset failed", "error");
    } finally {
      setBusy(false);
    }
  }

  function toggleButton(code: number) {
    setButtons((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    );
  }

  function readSeed(file: File | undefined) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setSeedImage(String(reader.result));
      setSeedName(file.name);
      setReset(true);
      addLog("seed", file.name);
    };
    reader.readAsDataURL(file);
  }

  if (!authed) {
    return (
      <main className="lockscreen">
        <form className="lock-panel" onSubmit={unlock}>
          <div className="lock-mark">
            <Lock size={26} />
          </div>
          <h1>Waypoint Portal</h1>
          <label>
            Password
            <input
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              spellCheck={false}
            />
          </label>
          <button className="primary wide" type="submit">
            <Shield size={18} />
            Enter
          </button>
          {passwordError ? <p className="error-text">{passwordError}</p> : null}
        </form>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Waypoint Portal</h1>
          <p>{health?.cuda.name || "RunPod endpoint"}</p>
        </div>
        <div className="top-actions">
          <StatusPill health={health} error={healthError} />
          <button className="icon-button" onClick={lock} title="Lock portal">
            <LogOut size={18} />
          </button>
        </div>
      </header>

      <section className="workspace">
        <aside className="control-panel">
          <div className="panel-section">
            <div className="section-title">
              <Activity size={16} />
              Endpoint
            </div>
            <dl className="metrics">
              <div>
                <dt>Device</dt>
                <dd>{health?.device || "..."}</dd>
              </div>
              <div>
                <dt>VRAM</dt>
                <dd>
                  {health?.cuda.memory_reserved_mb
                    ? `${(health.cuda.memory_reserved_mb / 1024).toFixed(1)} GB`
                    : "..."}
                </dd>
              </div>
              <div>
                <dt>State</dt>
                <dd>{health?.seeded ? "seeded" : "fresh"}</dd>
              </div>
              <div>
                <dt>Torch</dt>
                <dd>{health?.torch || "..."}</dd>
              </div>
            </dl>
          </div>

          <div className="panel-section">
            <div className="section-title">
              <MousePointer2 size={16} />
              Control
            </div>
            <div className="key-grid">
              {keyButtons.map((item) => {
                const Icon = item.icon;
                const pressed = buttons.includes(item.code);
                return (
                  <button
                    key={item.code}
                    className={pressed ? "key active" : "key"}
                    onClick={() => toggleButton(item.code)}
                    title={item.label}
                  >
                    <Icon size={18} />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="slider-row">
              <label>
                Mouse X
                <input
                  type="range"
                  min="-0.12"
                  max="0.12"
                  step="0.01"
                  value={mouseX}
                  onChange={(event) => setMouseX(Number(event.target.value))}
                />
              </label>
              <span>{mouseX.toFixed(2)}</span>
            </div>
            <div className="slider-row">
              <label>
                Mouse Y
                <input
                  type="range"
                  min="-0.12"
                  max="0.12"
                  step="0.01"
                  value={mouseY}
                  onChange={(event) => setMouseY(Number(event.target.value))}
                />
              </label>
              <span>{mouseY.toFixed(2)}</span>
            </div>
          </div>

          <div className="panel-section">
            <div className="section-title">
              <ImagePlus size={16} />
              Seed
            </div>
            <input
              ref={fileRef}
              className="hidden-file"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(event) => readSeed(event.target.files?.[0])}
            />
            <button className="secondary wide" onClick={() => fileRef.current?.click()}>
              <ImagePlus size={18} />
              {seedName || "Choose Image"}
            </button>
            {seedImage ? (
              <button
                className="ghost wide"
                onClick={() => {
                  setSeedImage(null);
                  setSeedName("");
                  setReset(true);
                }}
              >
                Clear Seed
              </button>
            ) : null}
          </div>

          <div className="panel-section actions">
            <label className="stepper">
              Steps
              <input
                type="number"
                min={1}
                max={4}
                value={steps}
                onChange={(event) => setSteps(Number(event.target.value))}
              />
            </label>
            <label className="toggle">
              <input type="checkbox" checked={reset} onChange={(event) => setReset(event.target.checked)} />
              Reset
            </label>
            <button className={streaming ? "danger wide" : "primary wide"} onClick={streaming ? stopDrive : startDrive} disabled={busy}>
              {streaming ? <Square size={18} /> : <Play size={18} />}
              {streaming ? "Stop Drive" : "Start Drive"}
            </button>
            <button className="secondary wide" onClick={generate} disabled={busy || streaming}>
              {busy ? <Loader2 className="spin" size={18} /> : <Play size={18} />}
              Generate
            </button>
            <button className="secondary wide" onClick={resetWorld} disabled={busy || streaming}>
              <RotateCcw size={18} />
              Reset State
            </button>
          </div>
        </aside>

        <section className="output-panel">
          <div className="output-header">
            <div>
              <h2>Frames</h2>
              <p>
                {streaming
                  ? `${Math.max(driveFrames, frames.length)} streamed frames, ${activeButtonLabels.join("+") || "idle"}`
                  : lastRun
                    ? `${lastRun.frame_count} frames, ${lastRun.total_seconds}s, ${activeButtonLabels.join("+") || "idle"}`
                    : "Awaiting generation"}
              </p>
            </div>
            {frames[0] ? (
              <a
                className="icon-button"
                href={`data:${frameMime};base64,${displayFrame || frames[0]}`}
                download="waypoint-frame.png"
                title="Download first frame"
              >
                <Download size={18} />
              </a>
            ) : null}
          </div>

          <div className={frames.length ? "viewport-stack" : "empty-output"}>
            {frames.length ? (
              <>
                <figure className="live-viewport">
                  <img src={`data:${frameMime};base64,${displayFrame || frames[0]}`} alt="Live generated viewport" />
                  <figcaption>{streaming ? "Drive" : "Latest"}</figcaption>
                </figure>
                <div className="frame-strip">
                  {frames.map((frame, index) => (
                    <figure key={`${frame.slice(0, 24)}-${index}`} className="frame-tile">
                      <img src={`data:${frameMime};base64,${frame}`} alt={`Generated frame ${index + 1}`} />
                      <figcaption>{String(index + 1).padStart(2, "0")}</figcaption>
                    </figure>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-mark">
                <Play size={24} />
              </div>
            )}
          </div>

          <div className="log-strip">
            {logs.length ? (
              logs.map((entry) => (
                <div className={`log-entry ${entry.kind}`} key={entry.id}>
                  <span>{entry.label}</span>
                  <p>{entry.detail}</p>
                </div>
              ))
            ) : (
              <div className="log-entry">
                <span>ready</span>
                <p>portal loaded</p>
              </div>
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

function StatusPill({ health, error }: { health: Health | null; error: string }) {
  if (error) return <div className="status error">offline</div>;
  if (!health) return <div className="status warn">checking</div>;
  return <div className="status ok">online</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
