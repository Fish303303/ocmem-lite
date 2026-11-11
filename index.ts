import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

/**
 * ocmem —— 省 token 的长期记忆插件
 * 设计：
 * 1) 事实存本地 JSON，一条一句话，超长自动截断（默认 160 字）
 * 2) 摘要（最多 8 条 × 60 字）写进 ~/.config/opencode/AGENTS.md 的受管区块，
 *    随系统提示自动带上下文，不需要每次工具调用
 * 3) 只有一个工具 memory{action,text,query,id}，工具说明压到最短
 * 4) 检索用字二元组匹配 + 使用频次/新鲜度加权，不装向量模型、不调外部 API
 */

const HOME = os.homedir()
const DATA_DIR = path.join(HOME, ".local", "share", "ocmem")
const DB_FILE = path.join(DATA_DIR, "memories.json")
const RECENT_FILE = path.join(DATA_DIR, "recent.json")
const AGENTS_FILE = path.join(HOME, ".config", "opencode", "AGENTS.md")
const BEGIN = "<!-- ocmem:begin -->"
const END = "<!-- ocmem:end -->"
const MAX_FACTS = 300
const DIGEST_N = 8
const DIGEST_CHARS = 60
const FACT_CHARS = 160
const RECENT_N = 4
const RECENT_KEEP = 6

type Mem = { id: string; text: string; at: number; uses: number; topic?: string; kind?: "fact" | "scene"; distilled?: boolean }

function load(): Mem[] {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

function save(items: Mem[]) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(DB_FILE, JSON.stringify(items), "utf8")
}

function norm(s: string) {
  return s.toLowerCase().replace(/[\s，。,.!?！？:：;；、"'“”‘’()（）\[\]【】]/g, "")
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>()
  const n = norm(s)
  if (n.length === 1) out.add(n)
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2))
  return out
}

function searchScore(m: Mem, q: string) {
  const a = bigrams(q)
  if (a.size === 0) return 0
  const b = bigrams(m.text)
  let hit = 0
  for (const g of a) if (b.has(g)) hit++
  const rel = hit / a.size
  const ageDays = (Date.now() - m.at) / 86400000
  const decay = 1 / (1 + ageDays / 60)
  return rel * 2 + Math.min(m.uses, 5) * 0.1 + decay * 0.2
}

function rank(items: Mem[]) {
  return [...items].sort((x, y) => {
    const sx = Math.min(x.uses, 5) * 0.4 + 1 / (1 + (Date.now() - x.at) / 86400000 / 30)
    const sy = Math.min(y.uses, 5) * 0.4 + 1 / (1 + (Date.now() - y.at) / 86400000 / 30)
    return sy - sx
  })
}

type Recent = { t: string; at: number; sid?: string }

function loadRecent(): Recent[] {
  try {
    const raw = JSON.parse(fs.readFileSync(RECENT_FILE, "utf8"))
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/** 按码点截断，避免把 emoji 从中间切开 */
function clamp(s: string, n: number) {
  const cps = Array.from(s)
  return cps.length > n ? cps.slice(0, n).join("") : s
}

/** 清成单行：抹掉受管区块标记（防止伪造 begin/end 把区块搞坏）、控制字符、首尾引号 */
function oneLine(s: string) {
  return s
    .replace(/<!--\s*ocmem:(begin|end)\s*-->/gi, " ")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[“”"'‘’「」『』]+/, "")
    .replace(/[“”"'‘’「」『』]+$/, "")
    .replace(/[。.]+$/, "")
    .trim()
}

/** 最近对话只做参考：问句、太短的一次性指令、连发重复都不记 */
function pushRecent(text: string, sid = "") {
  const t = clamp(oneLine(text), 80)
  if (Array.from(t).length < 4) return
  if (isQuestion(t)) return
  const arr = loadRecent()
  const last = arr[arr.length - 1]
  if (last && last.t === t && last.sid === sid) return
  arr.push({ t, at: Date.now(), sid })
  const seen = new Set<string>()
  const kept: Recent[] = []
  for (let i = arr.length - 1; i >= 0 && kept.length < RECENT_KEEP; i--) {
    if (seen.has(arr[i].t)) continue
    seen.add(arr[i].t)
    kept.unshift(arr[i])
  }
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(RECENT_FILE, JSON.stringify(kept), "utf8")
}

// L2 主题分堆：注入只带当前主题，其它主题只报条数
const TOPICS: Array<{ name: string; kws: string[] }> = [
  { name: "编码", kws: ["代码", "插件", "opencode", "记忆", "脚本", "程序", "bug", "仓库", "git", "部署", "接口", "函数", "agent", "编译"] },
  { name: "电脑", kws: ["桌面", "桌宠", "微信", "文件", "窗口", "电脑", "截图", "系统", "浏览器", "路径"] },
  { name: "工作", kws: ["周报", "老板", "汇报", "会议", "同事", "公司", "工作", "周记"] },
  { name: "生活", kws: ["吃饭", "睡觉", "天气", "身体", "游戏", "电影", "朋友", "家里", "生日"] },
]

function topicOf(text: string): string {
  const s = text.toLowerCase()
  let best = "其它"
  let bestScore = 0
  for (const t of TOPICS) {
    let score = 0
    for (const k of t.kws) if (s.includes(k)) score++
    if (score > bestScore) {
      bestScore = score
      best = t.name
    }
  }
  return best
}

function writeDigest(items: Mem[], sid = "") {
  const tagged = items.map((m) => ({ ...m, topic: topicOf(m.text) }))
  const curTopic = topicOf(loadRecent().map((r) => r.t).join(" "))
  const scenes = rank(tagged.filter((m) => m.kind === "scene")).slice(0, 6)
  const pending = tagged.filter((m) => m.kind !== "scene" && !m.distilled)
  const same = pending.filter((m) => m.topic === curTopic)
  const top = scenes.length > 0 ? scenes : rank(same.length > 0 ? same : pending).slice(0, 6)
  let cur = ""
  try {
    cur = fs.readFileSync(AGENTS_FILE, "utf8")
  } catch {}
  const all = loadRecent()
  // 当前会话的消息本来就在上下文里，不写进系统提示：
  // 否则每来一条消息 AGENTS.md 就改写一次，缓存全掉，还反过来更费 token。
  const recent = (sid ? all.filter((r) => r.sid !== sid) : all).slice(-RECENT_N)
  const lines: string[] = []
  if (top.length > 0) {
    lines.push(
      scenes.length > 0
        ? "## 记忆摘要（场景，插件自动生成勿手改）"
        : `## 记忆摘要（当前主题：${curTopic}，插件自动生成勿手改）`,
      ...top.map((m) => "- " + clamp(oneLine(m.text), DIGEST_CHARS))
    )
    const others = new Map<string, number>()
    for (const m of pending) {
      const t = m.topic || "其它"
      if (t !== curTopic) others.set(t, (others.get(t) || 0) + 1)
    }
    if (others.size > 0) {
      lines.push(
        "其它主题：" + [...others].map(([k, v]) => `${k}${v}条`).join(" ") + "（要查用 memory search）"
      )
    }
  }
  if (recent.length > 0) {
    lines.push("## 上次聊到", ...recent.map((r) => "- " + clamp(oneLine(r.t), DIGEST_CHARS)))
  }
  const block = lines.length > 0 ? `${BEGIN}\n${lines.join("\n")}\n${END}` : ""
  let next = cur
  if (cur.includes(BEGIN)) {
    const re = new RegExp("\\n*" + BEGIN + "[\\s\\S]*?" + END + "\\n*")
    next = cur.replace(re, block ? "\n\n" + block + "\n" : "")
    if (!block) next = next.trimEnd() + "\n"
  } else if (block) {
    next = cur.trimEnd() + "\n\n" + block + "\n"
  }
  if (next !== cur) fs.writeFileSync(AGENTS_FILE, next, "utf8")
}

function jaccard(a: string, b: string) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

function addFact(items: Mem[], text: string): { items: Mem[]; id: string; dup: boolean } {
  const clean = clamp(
    oneLine(text).replace(/^(用户要求|用户说|记住)[：:]\s*/, ""),
    FACT_CHARS
  )
  const key = norm(clean)
  const existing = items.find((m) => norm(m.text) === key || jaccard(m.text, clean) > 0.75)
  if (existing) {
    existing.at = Date.now()
    existing.uses += 1
    return { items, id: existing.id, dup: true }
  }
  const id = Math.random().toString(36).slice(2, 8)
  const items2 = items.concat([{ id, text: clean, at: Date.now(), uses: 0, topic: topicOf(clean) }])
  if (items2.length > MAX_FACTS) {
    const drop = rank(items2).slice(MAX_FACTS)
    for (const d of drop) {
      const i = items2.findIndex((m) => m.id === d.id)
      if (i >= 0) items2.splice(i, 1)
    }
  }
  return { items: items2, id, dup: false }
}

// 自动记忆：只存「稳定的偏好/事实」，不存问题、命令和一次性任务
const AUTO_PATTERNS = [
  /我(更|比较|最)?(喜欢|习惯|偏好|讨厌|不喜欢|受不了)/,
  /我(以后|以后都|一般|平时|每次|通常|向来|一直)/,
  /我(?!们)(的)?[^\s，。,.!?！？]{1,8}(是|叫|在|用|住|养|做)/,
  /(以后|今后|下次)(都)?(别|不要|必须|要|用|改成|换成|默认)/,
  /(默认|统一|一律)(用|走|按|都)/,
  /别(再)?(用|说|给|发|改|删|问)/,
  /(记住|记下)?(我的)?(规矩|习惯|偏好|原则)是/,
]

function isQuestion(s: string) {
  return /[?？]$/.test(s) || /(吗|呢|怎么|为什么|是不是|能不能|要不要|多少|什么|哪)/.test(s)
}

function autoCapture(text: string, sid = ""): { added: number } {
  let items = load()
  let added = 0
  const sentences = text
    .split(/[\n。！？!?；;]/)
    .map((s) => s.trim().replace(/^(那|嗯|哦|好|行)[，,、]?/, ""))
    .filter((s) => s.length >= 6 && s.length <= 80)
  for (const s of sentences) {
    if (isQuestion(s)) continue
    if (/测试|test|hello|hi\b/i.test(s)) continue
    if (!AUTO_PATTERNS.some((re) => re.test(s))) continue
    const r = addFact(items, s)
    items = r.items
    if (!r.dup) added++
  }
  if (added > 0) {
    save(items)
    writeDigest(items, sid)
  }
  return { added }
}

// L2 蒸馏：攒够 8 条再用便宜模型合并成 ≤4 条场景句；失败就保持原样，不影响对话
async function distill(ctx: any) {
  const items = load()
  const pending = items.filter((m) => m.kind !== "scene" && !m.distilled)
  if (pending.length < 8) return { ran: false }
  const sample = pending.slice(-12)
  const prompt =
    "把下面的记忆合并成不超过4条短句，每条不超过30个字，只输出句子，每行一条，不要编号不要解释。\n" +
    sample.map((m) => "- " + m.text).join("\n")
  let text = ""
  try {
    const r = await ctx.experimental.generate.text({
      prompt,
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
    })
    text = String(r?.text || "")
  } catch {
    return { ran: false }
  }
  const lines = text
    .split(/\r?\n/)
    .map((s: string) => s.replace(/^[-*\d.、\s]+/, "").trim())
    .filter((s: string) => s.length >= 4 && s.length <= 80)
    .slice(0, 4)
  if (lines.length === 0) return { ran: false }
  const now = Date.now()
  for (const m of sample) m.distilled = true
  for (const t of lines) {
    items.push({ id: Math.random().toString(36).slice(2, 8), text: t, at: now, uses: 1, kind: "scene" })
  }
  save(items)
  writeDigest(items)
  return { ran: true, scenes: lines.length }
}

export default Plugin.define({
  id: "ocmem",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memory",
        description:
          "长期记忆（已自动记录，不要用 add 重复保存）。search 查相关；list 列全部；forget 按 id 或原文删除；只有用户明确要求补记时才 add。",
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "search", "list", "forget"] },
            text: { type: "string", description: "要保存或删除的内容" },
            query: { type: "string", description: "检索词" },
            id: { type: "string", description: "记忆 id" },
          },
          required: ["action"],
        } as any,
        async execute(input: any) {
          let items = load()
          const action = String(input?.action || "")

          if (action === "add") {
            const text = String(input?.text || "").trim()
            if (!text) return { content: "text 不能为空" }
            const r = addFact(items, text)
            save(r.items)
            writeDigest(r.items)
            return { content: r.dup ? `已存在，已更新 #${r.id}` : `已记 #${r.id}` }
          }

          if (action === "search") {
            const q = String(input?.query || "")
            const hits = items
              .map((m) => ({ m, s: searchScore(m, q) }))
              .filter((x) => x.s > 0.2)
              .sort((a, b) => b.s - a.s)
              .slice(0, 3)
            for (const h of hits) h.m.uses += 1
            if (hits.length) save(items)
            return {
              content: hits.length
                ? hits.map((h) => `#${h.m.id} ${h.m.text.slice(0, 100)}`).join("\n")
                : "无相关记忆",
            }
          }

          if (action === "list") {
            return {
              content: items.length
                ? rank(items).map((m) => `#${m.id} ${m.text.slice(0, 100)}`).join("\n")
                : "空",
            }
          }

          if (action === "forget") {
            const id = String(input?.id || "").trim()
            const text = String(input?.text || "").trim()
            const before = items.length
            items = items.filter((m) =>
              id ? m.id !== id : text ? !norm(m.text).includes(norm(text)) : true
            )
            if (items.length === before) return { content: "没找到" }
            save(items)
            writeDigest(items)
            return { content: `已删 ${before - items.length} 条` }
          }

          return { content: "未知 action" }
        },
      } as any)
    })

    // 每条用户消息进来时，本地跑一遍规则；不调模型，不额外花 token
    await ctx.session.hook("prompt", async (input: any) => {
      try {
        const t = input?.prompt?.text
        const sid = String(
          input?.sessionID ?? input?.session?.id ?? input?.info?.sessionID ?? ""
        )
        if (typeof t === "string" && t.trim()) {
          autoCapture(t, sid)
          pushRecent(t, sid)
          writeDigest(load(), sid)
          const uns = load().filter((m) => m.kind !== "scene" && !m.distilled).length
          if (uns >= 8) void distill(ctx).catch(() => {})
        }
      } catch {}
    })
  },
})
