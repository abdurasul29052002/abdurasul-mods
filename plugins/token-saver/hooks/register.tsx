import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptSubmitInput, Register } from 'claude-code'

const LIMIT = 150_000
const COLD_MS = 60 * 60_000
const MIN_PROMPTS = 3

const lastAt = atom({ plugin: 'token-saver', key: 'lastPromptAt' } as const, null)
const count = atom({ plugin: 'token-saver', key: 'promptCount' } as const, 0)

const CLEAR = 'Tozalash (/clear)'
const COMPACT = 'Siqish (/compact)'
const GO = 'Baribir davom etish'

// Sent with every request: keep it short.
const RULES = `# token-saver: ish qoidalari
Bu qoidalar foydalanuvchi o'rnatgan token-saver plugin'idan. Foydalanuvchining o'z CLAUDE.md si bilan ziddiyat bo'lsa, CLAUDE.md ustun.

## Til
Foydalanuvchiga o'zbek tilida, oddiy so'zlar bilan javob ber. Inglizcha texnik atamani birinchi marta ishlatganda qavs ichida qisqa o'zbekcha izoh ber. Kod, izoh va commit xabarlari ingliz tilida.
Javobni maqtov yoki rozilik bilan boshlama. Yondashuvda xato bo'lsa, birinchi gapda ayt.

## Ikki rejim
1. Oddiy rejim (standart): bag tuzatish va kichik funksiyalar. Quyidagi vazifa qoidalari ishlaydi.
2. Reja rejimi: foydalanuvchi reja faylini bajarishni so'raganda ("avtonom ishla", "PLAN.md ni implement qil", "rejani davom ettir"). "token-saver:reja-rejimi" skill'ini yukla va unga amal qil; oddiy rejimdagi vazifa chegarasi qoidalari qo'llanilmaydi.
Kun boshi va oxiri ("xayrli tong", "bugunga yetadi") uchun "token-saver:kun-tartibi" skill'i bor.

## Vazifa chegarasi (oddiy rejim)
Foydalanuvchi vazifalarni bir-biriga ulab ketishi mumkin; chegarani kuzatish sening vazifang.
- Bitta vazifa = bitta bag tuzatish YOKI bitta funksiya. Funksiya ustida chiqqan baglar shu vazifaga kiradi.
- Yangi xabar kelganda, KOD O'QIMASDAN OLDIN, faqat xabar va joriy kontekstga qarab hal qil:
  - Joriy vazifa tugamagan va xabar unga bog'liq (o'sha modul, ekran yoki kod, undan chiqqan muammo, tuzatish) — bu shu vazifaning davomi, ishla.
  - Joriy vazifa tugamagan va xabar bog'liq emas — bir qatorda yoz: "Hozirgi ish hali tugamagan. Avval uni yopamizmi yoki buni alohida sessiyada qilamizmi?"
  - Joriy vazifa tugagan va xabar bog'liq — ishni boshla.
  - Xabar bog'liq emas (boshqa modul, ekran yoki repo) yoki shu sessiyada 3 tadan ortiq vazifa bajarilgan — kod o'qima, bir qatorda yoz: "Bu yangi mavzu. /clear qilib, shu vazifani qayta yozing."
  - Compact'dan keyin nechta vazifa bajarilgani noma'lum bo'lsa, sanama. Noma'lum yoki ikkilansang — bog'liq deb hisobla.

## Vazifa tugaganda (oddiy rejim)
- Vazifa tugadi = testlar o'tdi YOKI foydalanuvchi tasdiqladi. Testi yo'q o'zgarishda (masalan UI) tasdiqni kut, o'zing "tugadi" dema.
- Shunda o'zing commit qil, so'ramasdan: faqat o'zing o'zgartirgan fayllar, har bir tegilgan repoda alohida. Commit hash'larini ayt. Foydalanuvchi so'ramaguncha push qilma.
- Keyin hech narsa so'rama, keyingi vazifani kut.

## Commit va PR
- Conventional Commits (fix:, feat:, docs:, refactor:), birinchi qator 72 belgidan oshmasin.
- "Co-Authored-By" qatorini va "Generated with Claude Code" kabi belgini qo'shma.

## Kontekst va kesh
- Chegara foiz emas, aniq hajm: 150K token. Har vosita chaqiruvi butun kontekstni qayta o'qiydi, katta kontekst har chaqiruvni qimmatlashtiradi.
- Ko'p fayl o'qish yoki keng qidiruvni yordamchi agentga ber va faqat xulosasini ol.
- Xabar bilan "[token-saver: kontekst ...]" eslatmasi kelsa (oddiy rejim) va xabar joriy ishga bog'liq bo'lsa: ishni boshlama, bir qatorda yoz: "/compact <keyingi vazifa mavzusi> qilib, keyin davom etamiz."
- Kesh o'lganda plugin modelga yubormasdan o'zi so'raydi (tozalash, siqish yoki davom etish); sen bu haqda hech narsa qilma.
- Reja rejimida kontekst eslatmasiga e'tibor berma. Foydalanuvchi "davom et" desa, eslatmani unut va ishla.

## Xavfsizlik
Kodda ochiq yozilgan token, parol yoki kalit ko'rsang, qaysi vazifada bo'lishidan qat'i nazar, javobning birinchi qatorida ayt.

## Boshqa plugin'lar bilan
Reja rejimida savol beruvchi yoki tasdiq kutuvchi skill'larni (masalan superpowers brainstorming) ishlatma: reja allaqachon tasdiqlangan.`

const reminders = async ($: EngineInterface, e: PromptSubmitInput): Promise<string[] | { drop: string }> => {
  const now = await $.clock.now()
  const at = await read($, lastAt)
  const n = await read($, count)

  // Only the person's own typed prompts get reminders and count.
  const isTyped = !e.command && !e.isMeta && (e.origin.kind === 'composer' || e.origin.kind === 'channel')
  if (!isTyped) {
    await update($, lastAt, () => now)
    return []
  }

  // A cold cache makes the model re-read the whole context: ask before any request is sent (the dialog costs no tokens).
  if (at !== null && n >= MIN_PROMPTS && now - at > COLD_MS) {
    const minutes = Math.floor((now - at) / 60_000)
    const choice = await $.ui
      .ask(`Kesh o'lgan (${minutes} daqiqa). Keyingi xabar butun kontekstni qayta o'qiydi va token sarflaydi. Nima qilamiz?`, {
        header: 'Kesh',
        options: [CLEAR, COMPACT, GO]
      })
      .catch(() => CLEAR)
    if (choice === COMPACT) {
      const compacted = await $.session.compact().then(() => true, () => false)
      if (!compacted) return { drop: `Siqib bo'lmadi. /compact <mavzu> deb o'zingiz yozing.` }
    } else if (choice !== GO) {
      return { drop: `Model chaqirilmadi, token ketmadi. /clear yozing va vazifani qayta yozing.` }
    }
  }
  await update($, lastAt, () => now)
  await update($, count, c => c + 1)

  const extra: string[] = []
  const tokens = await $.session.usage().then(u => u.context.tokens, () => undefined)
  if (tokens !== undefined && tokens > LIMIT) {
    extra.push(`[token-saver: kontekst ${Math.round(tokens / 1000)}K token, chegara ${LIMIT / 1000}K]`)
  }

  return extra
}

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)

    return { sections: [...sections, { id: 'token-saver:rules', text: RULES, scope: 'session' }] }
  })

  on('prompt.submit', async ($, e, next) => {
    // A failing reminder only costs the reminder, never the prompt.
    const extra = await reminders($, e).catch(() => [])
    if ('drop' in extra) return extra

    return next(extra.length ? { ...e, context: [...(e.context ?? []), ...extra] } : e)
  })

  // Cache age counts from the last request, so a long turn keeps it warm.
  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastAt, () => now)

    return next(e)
  })

  // /clear raises no session.start, only the end of the old session.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, lastAt, () => null)
      await update($, count, () => 0)
    }

    return next(e)
  })
}
