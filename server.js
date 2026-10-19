import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();
const app = express();
const port = Number(process.env.PORT || 3000);
const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.8-flash";
const rateLimitMax = Math.max(1, Number(process.env.RATE_LIMIT_MAX || 20));
const rateLimitWindow = Math.max(10_000, Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000));
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const limiter = new Map();
const MAX_MESSAGES = 40;
const MAX_TEXT = 12_000;
const SYSTEM_INSTRUCTION = "أنت شات العرب، مساعد ذكاء اصطناعي عربي ودود ومفيد. أجب بالعربية ما لم يطلب المستخدم لغة أخرى. كن واضحاً وصادقاً، ولا تدّعِ أنك بحثت في الإنترنت أو نفذت إجراءً لم تنفذه. إذا لم تكن متأكداً فاذكر ذلك بوضوح.";

app.disable("x-powered-by");
app.use((req, res, next) => { res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "SAMEORIGIN"); res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); next(); });
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
function isConfigured() { return Boolean(apiKey && apiKey.length > 20); }
function clientKey(req) { return (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown").trim(); }
function checkRateLimit(req, res) { const now = Date.now(); const key = clientKey(req); const entry = limiter.get(key) || { count: 0, resetAt: now + rateLimitWindow }; if (now >= entry.resetAt) { entry.count = 0; entry.resetAt = now + rateLimitWindow; } entry.count += 1; limiter.set(key, entry); if (entry.count > rateLimitMax) { res.setHeader("Retry-After", Math.ceil((entry.resetAt - now) / 1000)); res.status(429).json({ error: "تم تجاوز عدد الطلبات المسموح مؤقتًا. انتظر قليلًا ثم حاول مجددًا." }); return false; } if (limiter.size > 5000) for (const [k, v] of limiter) if (v.resetAt < now) limiter.delete(k); return true; }
function validateMessages(input) { if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) return null; const messages = input.map((m) => ({ role: m?.role, text: typeof m?.text === "string" ? m.text.trim().slice(0, MAX_TEXT) : "" })).filter((m) => ["user", "model"].includes(m.role) && m.text); return messages.length && messages.at(-1).role === "user" ? messages : null; }
function sendSse(res, event, data) { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
app.get("/api/status", (_req, res) => res.json({ configured: isConfigured(), model }));
app.post("/api/chat/stream", async (req, res) => {
  if (!checkRateLimit(req, res)) return;
  if (!isConfigured()) return res.status(503).json({ error: "الخدمة غير مهيأة بعد. أضف GEMINI_API_KEY إلى إعدادات الخادم ثم أعد تشغيله." });
  const messages = validateMessages(req.body?.messages);
  if (!messages) return res.status(400).json({ error: "أرسل محادثة صحيحة، ويجب أن تكون آخر رسالة من المستخدم." });
  res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }); res.flushHeaders?.();
  const controller = new AbortController(); const abort = () => controller.abort(); req.on("aborted", abort); res.on("close", abort);
  try {
    const ai = new GoogleGenAI({ apiKey });
    const stream = await ai.models.generateContentStream({ model, contents: messages.map(({ role, text }) => ({ role, parts: [{ text }] })), config: { systemInstruction: SYSTEM_INSTRUCTION, temperature: 0.7, maxOutputTokens: 2048, abortSignal: controller.signal } });
    sendSse(res, "start", { model }); let emitted = false;
    for await (const chunk of stream) { if (controller.signal.aborted) break; const text = chunk.text || ""; if (text) { emitted = true; sendSse(res, "token", { text }); } }
    if (!controller.signal.aborted) sendSse(res, "done", { emitted });
  } catch (error) { if (!controller.signal.aborted) { console.error("Gemini request failed:", error?.status || error?.message || "unknown"); sendSse(res, "error", { error: "تعذّر الحصول على رد من Gemini. تحقق من إعدادات الخادم والاتصال ثم حاول مجددًا." }); } }
  finally { req.off("aborted", abort); res.off("close", abort); if (!res.writableEnded) res.end(); }
});
app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`شات العرب يعمل على http://localhost:${port} — النموذج: ${model}`));
