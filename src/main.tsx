import { FormEvent, PointerEvent, useEffect, useMemo, useRef, useState } from "react";
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
const DRIVE_STEP_PAUSE_MS = 0;
const DRIVE_JPEG_QUALITY = 70;
const DRIVE_VIDEO_FPS = 60;
const FRAME_WIDTH = 1280;
const FRAME_HEIGHT = 720;
const MOUSE_RANGE = 600;
const POINTER_MOUSE_SCALE = 6;
const VIDEO_EXPORT_TYPES = [
  { mime: "video/mp4;codecs=avc1.42E01E", extension: "mp4", label: "MP4" },
  { mime: "video/mp4;codecs=avc1.4D401E", extension: "mp4", label: "MP4" },
  { mime: "video/mp4;codecs=avc1.64001F", extension: "mp4", label: "MP4" },
  { mime: "video/mp4;codecs=h264", extension: "mp4", label: "MP4" },
  { mime: "video/mp4", extension: "mp4", label: "MP4" },
  { mime: "video/webm;codecs=vp9", extension: "webm", label: "WebM" },
  { mime: "video/webm;codecs=vp8", extension: "webm", label: "WebM" },
  { mime: "video/webm", extension: "webm", label: "WebM" },
] as const;

type Health = {
  ok: boolean;
  model?: string;
  model_label?: string;
  models?: ResolutionOption[];
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

type ResolutionOption = {
  key: string;
  label: string;
  width: number;
  height: number;
};

type GenerateResponse = {
  ok: boolean;
  frames: string[];
  frame_mime?: string;
  frame_width?: number;
  frame_height?: number;
  frame_count: number;
  steps: number;
  step_seconds: number[];
  total_seconds: number;
  error?: string;
};

type FrameTimings = {
  gen_ms?: number;
  decode_ms?: number;
  encode_ms?: number;
  write_ms?: number;
  total_ms?: number;
};

type StreamEvent =
  | {
      ok: true;
      type: "frame";
      frame: string;
      frame_mime?: string;
      frame_width?: number;
      frame_height?: number;
      frame_index: number;
      frame_number: number;
      step: number;
      steps: number;
      step_seconds: number;
      total_seconds: number;
      timings?: FrameTimings;
    }
  | {
      ok: true;
      type: "metric";
      frame_number: number;
      timings: FrameTimings;
    }
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
      frame_count?: number;
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

type RecordedFrame = {
  frame?: string;
  blob?: Blob;
  mime: string;
};

type PreviewFrame = {
  url: string;
  mime: string;
};

type BinaryStreamEvent = Omit<Extract<StreamEvent, { type: "frame" }>, "frame"> | Exclude<StreamEvent, { type: "frame" | "frame_batch" }>;

const keyButtons = [
  { code: 87, label: "W", icon: ArrowUp },
  { code: 65, label: "A", icon: ArrowLeft },
  { code: 83, label: "S", icon: ArrowDown },
  { code: 68, label: "D", icon: ArrowRight },
  { code: 32, label: "Space", icon: Square },
];
const mouseButtons = [
  { code: 1, label: "LMB", icon: MousePointer2 },
  { code: 2, label: "RMB", icon: MousePointer2 },
  { code: 4, label: "MMB", icon: MousePointer2 },
];
const controlButtons = [...keyButtons, ...mouseButtons];
const pointerButtonCodes: Record<number, number> = {
  0: 1,
  1: 4,
  2: 2,
};
const defaultResolutions: ResolutionOption[] = [
  { key: "720p", label: "720P", width: 1280, height: 720 },
  { key: "360p", label: "360P", width: 640, height: 360 },
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
  const [resolution, setResolution] = useState("720p");
  const [reset, setReset] = useState(true);
  const [buttons, setButtons] = useState<number[]>([87]);
  const [mouseX, setMouseX] = useState(0);
  const [mouseY, setMouseY] = useState(0);
  const [lastMouseSent, setLastMouseSent] = useState({ x: 0, y: 0 });
  const [seedImage, setSeedImage] = useState<string | null>(null);
  const [seedName, setSeedName] = useState("");
  const [frames, setFrames] = useState<string[]>([]);
  const [frameMime, setFrameMime] = useState("image/png");
  const [displayFrame, setDisplayFrame] = useState<string | null>(null);
  const [hasLiveFrame, setHasLiveFrame] = useState(false);
  const [previewFrames, setPreviewFrames] = useState<PreviewFrame[]>([]);
  const [frameSize, setFrameSize] = useState({ width: FRAME_WIDTH, height: FRAME_HEIGHT });
  const [perf, setPerf] = useState<FrameTimings | null>(null);
  const [lastRun, setLastRun] = useState<GenerateResponse | null>(null);
  const [recordedFrames, setRecordedFrames] = useState(0);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoMime, setVideoMime] = useState("");
  const [videoExtension, setVideoExtension] = useState("mp4");
  const [videoLabel, setVideoLabel] = useState("MP4");
  const [encodingVideo, setEncodingVideo] = useState(false);
  const [encodingProgress, setEncodingProgress] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lookPointerRef = useRef<{ id: number; x: number; y: number; buttonCode?: number } | null>(null);
  const pendingMouseRef = useRef({ x: 0, y: 0 });
  const recordedFramesRef = useRef<RecordedFrame[]>([]);
  const previewUrlsRef = useRef<string[]>([]);
  const frameSizeRef = useRef({ width: FRAME_WIDTH, height: FRAME_HEIGHT });
  const videoUrlRef = useRef("");
  const controlsRef = useRef({ buttons, mouseX, mouseY, seedImage, reset, resolution });

  const activeButtonLabels = useMemo(
    () => controlButtons.filter((item) => buttons.includes(item.code)).map((item) => item.label),
    [buttons],
  );

  useEffect(() => {
    if (!authed) return;
    void fetchHealth();
    const timer = window.setInterval(fetchHealth, 12000);
    return () => window.clearInterval(timer);
  }, [authed]);

  useEffect(() => {
    controlsRef.current = { buttons, mouseX, mouseY, seedImage, reset, resolution };
  }, [buttons, mouseX, mouseY, seedImage, reset, resolution]);

  const resolutionOptions = health?.models?.length ? health.models : defaultResolutions;

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
    return () => {
      abortRef.current?.abort();
      revokeVideoUrl();
      clearPreviewUrls();
    };
  }, []);

  function addLog(label: string, detail: string, kind: LogEntry["kind"] = "ok") {
    setLogs((current) => [{ id: Date.now(), label, detail, kind }, ...current].slice(0, 8));
  }

  function revokeVideoUrl() {
    if (videoUrlRef.current) {
      URL.revokeObjectURL(videoUrlRef.current);
      videoUrlRef.current = "";
    }
  }

  function clearVideoUrl() {
    revokeVideoUrl();
    setVideoUrl("");
    setVideoMime("");
    setVideoExtension("mp4");
    setVideoLabel("MP4");
    setEncodingProgress(0);
  }

  function clearPreviewUrls() {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
    setPreviewFrames([]);
  }

  function setActiveFrameSize(width?: number, height?: number) {
    if (!width || !height) return;
    const next = { width, height };
    frameSizeRef.current = next;
    setFrameSize(next);
  }

  function resetDriveCapture() {
    recordedFramesRef.current = [];
    setRecordedFrames(0);
    clearPreviewUrls();
    clearVideoUrl();
  }

  function recordDriveFrame(frame: RecordedFrame) {
    recordedFramesRef.current.push(frame);
    setRecordedFrames(recordedFramesRef.current.length);
  }

  function addPreviewFrame(blob: Blob, mime: string) {
    const url = URL.createObjectURL(blob);
    previewUrlsRef.current.push(url);
    setPreviewFrames((current) => {
      const next = [...current, { url, mime }];
      const dropped = next.splice(0, Math.max(0, next.length - 4));
      dropped.forEach((item) => {
        URL.revokeObjectURL(item.url);
        previewUrlsRef.current = previewUrlsRef.current.filter((stored) => stored !== item.url);
      });
      return next;
    });
  }

  function base64ToBlob(frame: string, mime: string) {
    const binary = atob(frame);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime });
  }

  async function drawFrameBlob(blob: Blob, width?: number, height?: number) {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const nextWidth = width || frameSizeRef.current.width;
    const nextHeight = height || frameSizeRef.current.height;
    if (canvas.width !== nextWidth) canvas.width = nextWidth;
    if (canvas.height !== nextHeight) canvas.height = nextHeight;
    setActiveFrameSize(nextWidth, nextHeight);

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return;

    if ("createImageBitmap" in window) {
      const bitmap = await createImageBitmap(blob);
      context.drawImage(bitmap, 0, 0, nextWidth, nextHeight);
      bitmap.close();
    } else {
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        const url = URL.createObjectURL(blob);
        image.onload = () => {
          context.drawImage(image, 0, 0, nextWidth, nextHeight);
          URL.revokeObjectURL(url);
          resolve();
        };
        image.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error("could not decode frame"));
        };
        image.src = url;
      });
    }
    setHasLiveFrame(true);
  }

  async function handleFrameBlob(blob: Blob, mime: string, event: Pick<Extract<StreamEvent, { type: "frame" }>, "frame_number" | "frame_width" | "frame_height" | "steps" | "step_seconds" | "total_seconds" | "timings">) {
    recordDriveFrame({ blob, mime });
    addPreviewFrame(blob, mime);
    setFrameMime(mime);
    setDriveFrames((current) => Math.max(current + 1, event.frame_number));
    setPerf((current) => ({ ...current, ...event.timings }));
    setLastRun({
      ok: true,
      frames: [],
      frame_mime: mime,
      frame_count: event.frame_number,
      steps: event.steps,
      step_seconds: [event.step_seconds],
      total_seconds: event.total_seconds,
    });
    await drawFrameBlob(blob, event.frame_width, event.frame_height);
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
        model: resolution,
        reset,
        button: buttons,
        mouse: [mouseX, mouseY],
        seed_image: seedImage,
      });
      setFrames(payload.frames);
      setFrameMime(payload.frame_mime || "image/png");
      setDisplayFrame(payload.frames[0] || null);
      clearPreviewUrls();
      setHasLiveFrame(Boolean(payload.frames[0]));
      setActiveFrameSize(payload.frame_width, payload.frame_height);
      if (payload.frames[0]) {
        await drawFrameBlob(base64ToBlob(payload.frames[0], payload.frame_mime || "image/png"), payload.frame_width, payload.frame_height);
      }
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
        if (event.type === "frame") {
          const frameMime = event.frame_mime || "image/jpeg";
          const blob = base64ToBlob(event.frame, frameMime);
          recordDriveFrame({ frame: event.frame, mime: frameMime });
          setFrames((current) => [...current, event.frame].slice(-4));
          setFrameMime(frameMime);
          setDisplayFrame(event.frame);
          setActiveFrameSize(event.frame_width, event.frame_height);
          setPerf((current) => ({ ...current, ...event.timings }));
          await drawFrameBlob(blob, event.frame_width, event.frame_height);
          setDriveFrames((current) => Math.max(current + 1, event.frame_number));
          setLastRun({
            ok: true,
            frames: [event.frame],
            frame_mime: frameMime,
            frame_count: 1,
            steps: event.steps,
            step_seconds: [event.step_seconds],
            total_seconds: event.total_seconds,
          });
        } else if (event.type === "metric") {
          setPerf((current) => ({ ...current, ...event.timings }));
        } else if (event.type === "frame_batch") {
          const frameMime = event.frame_mime || "image/jpeg";
          event.frames.forEach((frame) => recordDriveFrame({ frame, mime: frameMime }));
          setFrames(event.frames);
          setFrameMime(frameMime);
          setDisplayFrame(event.frames.at(-1) || null);
          if (event.frames.at(-1)) {
            await drawFrameBlob(base64ToBlob(event.frames.at(-1) || "", frameMime));
          }
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

  function appendBytes(left: Uint8Array<ArrayBuffer>, right: Uint8Array): Uint8Array<ArrayBuffer> {
    const next = new Uint8Array(right.length);
    next.set(right);
    if (!left.length) return next;
    const merged = new Uint8Array(left.length + right.length);
    merged.set(left);
    merged.set(next, left.length);
    return merged;
  }

  async function handleBinaryEvent(event: BinaryStreamEvent, imageBytes: Uint8Array) {
    if (!event.ok) {
      throw new Error(event.error);
    }
    if (event.type === "frame") {
      const frameMime = event.frame_mime || "image/jpeg";
      const imageCopy = new Uint8Array(imageBytes.byteLength);
      imageCopy.set(imageBytes);
      const blob = new Blob([imageCopy.buffer], { type: frameMime });
      await handleFrameBlob(blob, frameMime, event);
    } else if (event.type === "metric") {
      setPerf((current) => ({ ...current, ...event.timings }));
    }
  }

  async function readBinaryStream(response: Response) {
    if (!response.body) {
      throw new Error("stream response had no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer: Uint8Array<ArrayBuffer> = new Uint8Array(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = appendBytes(buffer, value);

      while (buffer.length >= 8) {
        const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        const headerLength = view.getUint32(0);
        const imageLength = view.getUint32(4);
        const messageLength = 8 + headerLength + imageLength;
        if (buffer.length < messageLength) break;

        const headerBytes = buffer.slice(8, 8 + headerLength);
        const imageBytes = buffer.slice(8 + headerLength, messageLength);
        buffer = buffer.slice(messageLength);

        const event = JSON.parse(decoder.decode(headerBytes)) as BinaryStreamEvent;
        await handleBinaryEvent(event, imageBytes);
      }
    }
  }

  async function streamStep(controller: AbortController, firstStep: boolean) {
    const current = controlsRef.current;
    const pendingMouse = pendingMouseRef.current;
    const mouse = [
      Math.round(clampMouse(current.mouseX + pendingMouse.x)),
      Math.round(clampMouse(current.mouseY + pendingMouse.y)),
    ];
    pendingMouseRef.current = { x: 0, y: 0 };
    setLastMouseSent({ x: mouse[0], y: mouse[1] });

    const response = await fetch("/api/waypoint?action=stream-binary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: 1,
        format: "jpeg",
        quality: DRIVE_JPEG_QUALITY,
        model: current.resolution,
        reset: firstStep ? current.reset : false,
        button: current.buttons,
        mouse,
        seed_image: firstStep ? current.seedImage : undefined,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || "stream failed");
    }

    if (response.headers.get("Content-Type")?.includes("application/vnd.waypoint.frames")) {
      await readBinaryStream(response);
    } else {
      await readStream(response);
    }
  }

  async function startDrive() {
    if (streaming || busy) return;

    const controller = new AbortController();
    abortRef.current = controller;
    resetDriveCapture();
    setStreaming(true);
    setDriveFrames(0);
    addLog("drive", "started");

    let firstStep = true;
    try {
      while (!controller.signal.aborted) {
        await streamStep(controller, firstStep);
        firstStep = false;
        setReset(false);
        if (DRIVE_STEP_PAUSE_MS > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, DRIVE_STEP_PAUSE_MS));
        }
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

  function clampMouse(value: number) {
    return Math.max(-MOUSE_RANGE, Math.min(MOUSE_RANGE, value));
  }

  function setMouseVector(nextX: number, nextY: number) {
    setMouseX(clampMouse(nextX));
    setMouseY(clampMouse(nextY));
  }

  function setButtonHeld(code: number, pressed: boolean) {
    setButtons((current) => {
      const has = current.includes(code);
      if (pressed && !has) return [...current, code];
      if (!pressed && has) return current.filter((item) => item !== code);
      return current;
    });
  }

  function addPendingMouse(dx: number, dy: number) {
    pendingMouseRef.current = {
      x: clampMouse(pendingMouseRef.current.x + dx),
      y: clampMouse(pendingMouseRef.current.y + dy),
    };
  }

  function captureLookPointer(event: PointerEvent<HTMLElement>, includeButton: boolean) {
    event.preventDefault();
    const buttonCode = includeButton ? pointerButtonCodes[event.button] : undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    lookPointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, buttonCode };
    if (buttonCode) setButtonHeld(buttonCode, true);
  }

  function updateLookFromPointer(event: PointerEvent<HTMLElement>) {
    const previous = lookPointerRef.current;
    if (!previous || previous.id !== event.pointerId) return;

    const dx = (event.clientX - previous.x) * POINTER_MOUSE_SCALE;
    const dy = (event.clientY - previous.y) * POINTER_MOUSE_SCALE;
    lookPointerRef.current = { ...previous, x: event.clientX, y: event.clientY };
    addPendingMouse(dx, dy);
  }

  function releaseLookPointer(event: PointerEvent<HTMLElement>) {
    const previous = lookPointerRef.current;
    if (previous?.id === event.pointerId) {
      lookPointerRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
      if (previous.buttonCode) setButtonHeld(previous.buttonCode, false);
    }
  }

  function getVideoExportType() {
    return VIDEO_EXPORT_TYPES.find(({ mime }) => MediaRecorder.isTypeSupported(mime));
  }

  function loadFrameImage(recordedFrame: RecordedFrame): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = recordedFrame.frame ? `data:${recordedFrame.mime};base64,${recordedFrame.frame}` : undefined;
      const objectUrl = url ? "" : URL.createObjectURL(recordedFrame.blob!);
      image.onload = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        resolve(image);
      };
      image.onerror = () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        reject(new Error("could not decode recorded frame"));
      };
      image.src = url || objectUrl;
    });
  }

  async function exportDriveVideo() {
    if (encodingVideo) return;

    const capture = recordedFramesRef.current.slice();
    if (!capture.length) {
      addLog("video", "no drive frames captured", "warn");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      addLog("video", "MediaRecorder is not available in this browser", "error");
      return;
    }

    const exportType = getVideoExportType();
    if (!exportType) {
      addLog("video", "no supported video encoder found", "error");
      return;
    }

    clearVideoUrl();
    setEncodingVideo(true);
    setEncodingProgress(0);
    let stream: MediaStream | null = null;
    let recorder: MediaRecorder | null = null;

    try {
      const canvas = document.createElement("canvas");
      canvas.width = frameSizeRef.current.width;
      canvas.height = frameSizeRef.current.height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("could not create canvas context");

      stream = canvas.captureStream(DRIVE_VIDEO_FPS);
      recorder = new MediaRecorder(stream, {
        mimeType: exportType.mime,
        videoBitsPerSecond: 10_000_000,
      });
      const activeRecorder = recorder;
      const chunks: BlobPart[] = [];
      const stopped = new Promise<Blob>((resolve, reject) => {
        activeRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        activeRecorder.onerror = () => reject(new Error("video encoding failed"));
        activeRecorder.onstop = () => resolve(new Blob(chunks, { type: exportType.mime }));
      });

      activeRecorder.start();
      const frameDuration = 1000 / DRIVE_VIDEO_FPS;
      for (let index = 0; index < capture.length; index += 1) {
        const image = await loadFrameImage(capture[index]);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        setEncodingProgress(Math.round(((index + 1) / capture.length) * 100));
        await new Promise((resolve) => window.setTimeout(resolve, frameDuration));
      }

      activeRecorder.stop();
      const blob = await stopped;
      const nextUrl = URL.createObjectURL(blob);
      videoUrlRef.current = nextUrl;
      setVideoUrl(nextUrl);
      setVideoMime(blob.type || exportType.mime);
      setVideoExtension(exportType.extension);
      setVideoLabel(exportType.label);
      addLog("video", `${capture.length} frames exported as ${exportType.label}`);
    } catch (error) {
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      addLog("video", error instanceof Error ? error.message : "export failed", "error");
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      setEncodingVideo(false);
    }
  }

  async function resetWorld() {
    setBusy(true);
    try {
      await callApi("reset", { model: resolution });
      setReset(true);
      setFrames([]);
      setDisplayFrame(null);
      setHasLiveFrame(false);
      setLastRun(null);
      setPerf(null);
      resetDriveCapture();
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

  const latestPreviewFrame = previewFrames.at(-1);
  const hasOutput = hasLiveFrame || frames.length > 0 || previewFrames.length > 0;
  const perfSummary = perf
    ? `gen ${Math.round(perf.gen_ms || 0)}ms, decode ${Math.round(perf.decode_ms || 0)}ms, encode ${Math.round(
        perf.encode_ms || 0,
      )}ms${perf.write_ms !== undefined ? `, write ${Math.round(perf.write_ms)}ms` : ""}`
    : "";

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
                <dt>Model</dt>
                <dd>{health?.model_label || resolution.toUpperCase()}</dd>
              </div>
              <div>
                <dt>Torch</dt>
                <dd>{health?.torch || "..."}</dd>
              </div>
              <div>
                <dt>Gen</dt>
                <dd>{perf?.gen_ms !== undefined ? `${Math.round(perf.gen_ms)} ms` : "..."}</dd>
              </div>
              <div>
                <dt>Encode</dt>
                <dd>{perf?.encode_ms !== undefined ? `${Math.round(perf.encode_ms)} ms` : "..."}</dd>
              </div>
            </dl>
          </div>

          <div className="panel-section">
            <div className="section-title">
              <MousePointer2 size={16} />
              Control
            </div>
            <label className="select-row">
              Resolution
              <select
                value={resolution}
                onChange={(event) => {
                  setResolution(event.target.value);
                  setReset(true);
                  resetDriveCapture();
                }}
                disabled={streaming || busy}
              >
                {resolutionOptions.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label} ({item.width}x{item.height})
                  </option>
                ))}
              </select>
            </label>
            <div className="key-grid">
              {controlButtons.map((item) => {
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
                  min={-MOUSE_RANGE}
                  max={MOUSE_RANGE}
                  step="10"
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
                  min={-MOUSE_RANGE}
                  max={MOUSE_RANGE}
                  step="10"
                  value={mouseY}
                  onChange={(event) => setMouseY(Number(event.target.value))}
                />
              </label>
              <span>{mouseY.toFixed(2)}</span>
            </div>
            <button
              className="look-pad"
              type="button"
              onPointerDown={(event) => captureLookPointer(event, false)}
              onPointerMove={updateLookFromPointer}
              onPointerUp={releaseLookPointer}
              onPointerCancel={releaseLookPointer}
              title="Hold and drag to look"
            >
              <MousePointer2 size={18} />
              <span>Look Pad</span>
            </button>
            <button className="ghost wide" onClick={() => setMouseVector(0, 0)}>
              Center Look
            </button>
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
            <button
              className="secondary wide"
              onClick={exportDriveVideo}
              disabled={streaming || busy || encodingVideo || recordedFrames === 0}
            >
              {encodingVideo ? <Loader2 className="spin" size={18} /> : <Download size={18} />}
              {encodingVideo ? `Exporting ${encodingProgress}%` : "Export Drive Video"}
            </button>
            {videoUrl ? (
              <a className="secondary wide" href={videoUrl} download={`waypoint-drive.${videoExtension}`}>
                <Download size={18} />
                Download {videoLabel}
              </a>
            ) : null}
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
                  ? `${Math.max(driveFrames, frames.length)} streamed frames, mouse ${lastMouseSent.x} ${lastMouseSent.y}${perfSummary ? `, ${perfSummary}` : ""}`
                  : lastRun
                    ? `${recordedFrames || lastRun.frame_count} frames, ${videoUrl ? videoMime || "video ready" : activeButtonLabels.join("+") || "idle"}`
                    : "Awaiting generation"}
              </p>
            </div>
            {videoUrl ? (
              <a
                className="icon-button"
                href={videoUrl}
                download={`waypoint-drive.${videoExtension}`}
                title={`Download ${videoLabel} drive video`}
              >
                <Download size={18} />
              </a>
            ) : latestPreviewFrame ? (
              <a
                className="icon-button"
                href={latestPreviewFrame.url}
                download="waypoint-frame.jpg"
                title="Download latest frame"
              >
                <Download size={18} />
              </a>
            ) : frames[0] ? (
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

          <div className={hasOutput ? "viewport-stack" : "empty-output"}>
            {hasOutput ? (
              <>
                <figure className="live-viewport">
                  <canvas
                    ref={canvasRef}
                    width={frameSize.width}
                    height={frameSize.height}
                    aria-label="Live generated viewport"
                    onPointerDown={(event) => captureLookPointer(event, true)}
                    onPointerMove={updateLookFromPointer}
                    onPointerUp={releaseLookPointer}
                    onPointerCancel={releaseLookPointer}
                    onContextMenu={(event) => event.preventDefault()}
                  />
                  <figcaption>{streaming ? "Drive" : "Latest"}</figcaption>
                </figure>
                {previewFrames.length ? (
                  <div className="frame-strip">
                    {previewFrames.map((frame, index) => (
                      <figure key={frame.url} className="frame-tile">
                        <img src={frame.url} alt={`Generated frame ${index + 1}`} />
                        <figcaption>{String(index + 1).padStart(2, "0")}</figcaption>
                      </figure>
                    ))}
                  </div>
                ) : frames.length ? (
                  <div className="frame-strip">
                    {frames.map((frame, index) => (
                      <figure key={`${frame.slice(0, 24)}-${index}`} className="frame-tile">
                        <img src={`data:${frameMime};base64,${frame}`} alt={`Generated frame ${index + 1}`} />
                        <figcaption>{String(index + 1).padStart(2, "0")}</figcaption>
                      </figure>
                    ))}
                  </div>
                ) : null}
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
