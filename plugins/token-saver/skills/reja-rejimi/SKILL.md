---
name: reja-rejimi
description: Autonomous plan mode - use when the user asks to execute a plan file ("avtonom ishla", "PLAN.md ni implement qil", "rejani davom ettir", "rejani bajar"). Reja faylini to'xtamasdan, bosqichma-bosqich bajarish uchun.
---

# Reja rejimi (avtonom)

Reja — xotira: sessiya emas, fayl holatni saqlaydi. Reja fayli: loyiha papkasidagi PLAN.md (yoki foydalanuvchi ko'rsatgan boshqa fayl).

## Boshlash
- Rejani yozgan sessiyada implementatsiyani boshlama. Reja tayyor bo'lgach, bir qatorda yoz: "Reja tayyor. /clear qiling va 'avtonom ishla' deb yozing."
- Bosqichlar belgilash katakchalari bilan yozilsin: "- [ ] 1.1 ...". Reja shunday bo'lmasa, birinchi ish sifatida uni shu formatga keltir (mazmunini o'zgartirmasdan) va tasdiq so'ra. Bu — ishni boshlashdan oldingi yagona savol.
- "Avtonom ishla" deyilgandan keyin foydalanuvchi yo'q deb hisobla: bosqichlar va fazalar orasida to'xtama, davom etishni so'rama, /clear taklif qilma.
- Ishni boshlaganda (yoki compact'dan keyin) PLAN.md ni o'qi, birinchi "[ ]" bosqichni top va undan davom et. Bajarilganlarni qayta qilma.
- Reja rejimida token-saver'ning kontekst/kesh eslatmalariga e'tibor berma va savol beruvchi skill'larni (masalan superpowers brainstorming) ishlatma.

## Poydevor va qolgan qism
Fazalarni sarlavhada belgila:
- "## Faza N: ... [poydevor]" — arxitektura, asosiy modellar, umumiy interfeyslar, loyiha tuzilmasi; keyingi hamma narsa tayanadigan qismlar.
- "## Faza N: ... [agent]" — poydevor ustiga quriladigan, bir-biridan nisbatan mustaqil qismlar.
Belgilanmagan rejada fazalarni o'zing belgila va formatlash savoli bilan birga tasdiq so'ra.
- [poydevor] fazalarni o'zing, shu sessiyada bajar: har bosqichdan keyin build/testni tekshir, PLAN.md da "[x]" qo'y, commit qil (push qilma) va keyingisiga o't. Arxitektura, nomlash va uslub qarorlarini "## Qarorlar" bo'limiga yoz — keyingi agentlar shunga tayanadi.
- [agent] fazalarni yordamchi agentlarga ber.
- Har qanday fazada 20 qatordan kichik tuzatishni agentsiz, o'zing qil.

## Boshqaruvchi va yordamchi agentlar
- Sen boshqaruvchisan: kod yozishni yordamchi agentlarga topshir. Har "[ ]" bosqichni (yoki qattiq bog'liq 2–3 kichik bosqichni) bitta agentga ber. Parallel berma: ular bir xil fayllarga tegib, bir-birini buzishi mumkin.
- Agent turini (subagent_type) bosqich qiyinligiga qarab o'zing tanla. smart-router o'rnatilgan bo'lsa uning turlari: smart-router:router-easy / router-careful / router-normal / router-strong / router-hard — eng arzonidan boshla, o'tmasa bir daraja yuqorisiga o't. O'rnatilmagan bo'lsa, oddiy general-purpose agent ishlat.
- Topshiriq matniga bosqich murakkabligini ochiq yoz (masalan: "yangi arxitektura qismi", "oddiy CRUD", "bir nechta modulga tegadi"). Build/test o'tmagan bo'lsa, qayta topshiriqda nima ishlamagani va bosqich kutilganidan murakkabroq ekanini yoz.
- Topshiriq o'zi yetarli bo'lsin (agent suhbatni ko'rmaydi): bosqich matni, repo va fayllar, PLAN.md dagi "## Qarorlar", loyiha CLAUDE.md qoidalari, "tugagach build/testlarni ishga tushir" talabi.
- Qo'sh: "Boshlashdan oldin oldingi bosqich commit'ining diff'ini (git show <hash>) ko'r va o'sha nomlash va uslubni davom ettir."
- Agentdan faqat qisqa xulosa so'ra (10–15 qator): nima o'zgardi, qaysi fayllar, build/test natijasi, hal bo'lmagan muammo.
- Xulosaga ko'r-ko'rona ishonma: build va testlarni o'zing ishga tushir, "git diff --stat" ga qara. Kutilmagan fayl o'zgargan, test o'chirilgan yoki o'tkazib yuborilgan bo'lsa — qabul qilma, sababini yozib qayta topshir.
- Tekshiruvdan o'tgach: PLAN.md da "[x]", faqat shu bosqichda o'zgargan fayllarni har repoda alohida commit qil (push yo'q) va darhol keyingisiga o't.

## Faqat shu hollarda to'xta
- rejada xato, ziddiyat yoki noaniqlik — taxmin qilma, so'ra;
- bosqich rejadan jiddiy chetga chiqishni talab qiladi;
- bitta bosqichda build/test 3 urinishda ham o'tmadi (review'da rad etilgan diff ham urinish hisoblanadi) — nima sinalganini yoz va to'xta;
- reja to'liq bajarildi.

## Hisobot
- Har faza ("## " bo'lim) tugaganda to'xtamasdan PLAN.md oxiridagi "## Jurnal" ga bir qator yoz: faza nomi, commit hash'lari, muhim eslatmalar.
- Reja davomida yangi muhim qaror chiqsa, uni "## Qarorlar" ga bir qatorda yoz.
- Reja tugaganda yakuniy hisobot ber: bajarilgan fazalar, barcha commit hash'lari, ochiq muammolar, qo'lda tekshirish kerak joylar.
