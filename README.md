# abdurasul-mods

Claude Code uchun ikkita plugin (kengaytma) to'plami: `token-saver` (token tejaydigan ish qoidalari) va `smart-router` (vazifani qiyinligiga qarab model tanlash).

## Nima uchun

Maqsad — token tejash. Har bir vosita chaqiruvi (tool call) butun kontekstni (suhbat tarixini) qayta o'qiydi, shuning uchun kontekst qancha katta bo'lsa, har qadam shuncha qimmat. Tejash yo'li oddiy:

- vazifa chegarasini bilish: bitta vazifa — bitta bag yoki bitta funksiya;
- bog'liq bo'lmagan yangi mavzuda o'z vaqtida `/clear` (kontekstni tozalash);
- davom etadigan uzun ishda o'z vaqtida `/compact <mavzu>` (kontekstni qisqartirish).

## O'rnatish

Claude Code sessiyasida:

```
/plugin install token-saver --marketplace abdurasul29052002/abdurasul-mods
/plugin install smart-router --marketplace abdurasul29052002/abdurasul-mods
```

Yoki terminaldan:

```
claude plugin install token-saver --marketplace abdurasul29052002/abdurasul-mods
```

Har plugin alohida o'rnatiladi; smart-router ixtiyoriy. Marketplace qo'shishni so'rasa `y`, keyin o'rnatish doirasini (scope) tanlang.

Mahalliy variant (repo klon qilingan bo'lsa):

```
/plugin marketplace add <klon qilingan repo yo'li>
```

## Minimal Claude Code versiyasi

Kamida **2.1.309** kerak (mod formati: hooks modullari va `prompt.compose`). Tekshirish:

```
claude --version
```

Eski bo'lsa, Claude Code'ni yangilang (o'rnatgan usulingizga qarab, masalan `claude update`).

## token-saver

O'zbek tilidagi ish qoidalari. Plugin o'rnatilganda quyidagilar ishlaydi:

- **Qoidalar bo'limi** — har so'rovga system prompt (modelga beriladigan asosiy ko'rsatma) ichida qisqa qoidalar qo'shiladi: o'zbekcha javob uslubi, ikki ish rejimi, vazifa chegarasi, vazifa tugagach commit, commit xabari formati, kontekst va kesh qoidalari, xavfsizlik (ochiq token/parol haqida ogohlantirish).
- **Kontekst eslatmasi** — kontekst 150K tokendan oshsa, xabarga eslatma qo'shiladi va model `/compact <mavzu>` taklif qiladi.
- **Kesh eslatmasi** — oxirgi so'rovdan 60 daqiqadan ko'p o'tgan bo'lsa (sessiyada kamida 3 ta xabar yozilgan bo'lsa), kesh (cache, oldingi kontekstning tez o'qiladigan nusxasi) o'lgan bo'lishi mumkinligi haqida eslatma keladi. `/clear` hisoblagichni nolga qaytaradi.
- **Skill'lar** (skill — kerak bo'lganda yuklanadigan ko'rsatma):
  - `reja-rejimi` — "avtonom ishla", "PLAN.md ni implement qil", "rejani davom ettir", "rejani bajar" desangiz ishga tushadi: reja faylini to'xtamasdan bosqichma-bosqich bajaradi.
  - `kun-tartibi` — "bugunga yetadi" desangiz WORKLOG.md ga kunlik yozuv yozadi; "xayrli tong" / "hayrli tong" desangiz oxirgi yozuvdan hisobot beradi.

Muhim: sizning o'z `CLAUDE.md` faylingiz ziddiyat bo'lganda ustun. Shaxsiy narsalar (papka yo'llari, loyiha tuzilmasi, o'z odatlaringiz) plugin'ga emas, o'z `CLAUDE.md` ingizga yoziladi.

## smart-router (ixtiyoriy)

Vazifani qiyinligiga qarab mos model va effort (fikrlash darajasi) bilan bajaruvchi yordamchi agentga (subagent) yo'naltiradi. 5 ta agent turi bor:

| Tur | Model | Effort | Nima uchun |
|---|---|---|---|
| `router-easy` | Haiku | low | mexanik ish: o'qish, qidirish, nom o'zgartirish |
| `router-careful` | Haiku | xhigh | tor, lekin nozik ish: regex, chekka holatlar |
| `router-normal` | Sonnet | medium | aniq spec ichidagi oddiy kod va matn |
| `router-strong` | Sonnet | high | bir necha faylga tegadigan murakkabroq ish |
| `router-hard` | Opus | high | dizayn, qiyin debug, chuqur tahlil |

Eng arzon mos turdan boshlanadi; natija o'tmasa, bir daraja yuqoriga o'tiladi. Katta vazifa avval kichik vazifalarga bo'linadi va ularning holati progress panelida (dashboard) ko'rinadi.

Slash buyruqlari:

- `/router on | off` — yoqish, o'chirish yoki holatini ko'rish;
- `/dashboard` — vazifalar progress panelini ochish;
- `/token-stats` — token sarfini kun va papka bo'yicha ko'rish.

`token-saver` bu plugin'siz ham to'liq ishlaydi.

## Foydali odatlar

- Bog'liq bo'lmagan vazifalar orasida `/clear` qiling.
- Uzun, lekin bog'liq ishni davom ettirishdan oldin `/compact <mavzu>` qiling.
- Ko'p fayl o'qish yoki keng qidiruvni yordamchi agentga bering, o'zingiz faqat xulosasini oling.
- Bitta vazifa — bitta commit.
