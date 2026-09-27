import { describe, expect, it } from "vitest";
import { decodeEntities, decodeMimeWords, DEFAULT_SUBJECT, htmlToText, isForwardSubject, mailHtml, replySubject, splitReply } from "../../../src/channels/email/index.js";

// Текст письма: ответ клиента без прошлой переписки, HTML → текст, HTML ответа. Адреса и имена — вымышленные.

describe("ответ без прошлой переписки", () => {
  it("Gmail по-английски: всё от «On … wrote:» — прочь, начало цитаты — для подписи «в ответ на»", () => {
    const r = splitReply([
      "Thanks, see you tomorrow at 10.",
      "",
      "On Fri, Sep 26, 2026 at 10:00 AM Company <hello@company.example> wrote:",
      "",
      "> Hello! Your order is ready.",
      ">",
      "> Company",
    ].join("\n"));
    expect(r.reply).toBe("Thanks, see you tomorrow at 10.");
    expect(r.quote).toBe("Hello! Your order is ready. Company");
  });

  it("Gmail перенёс длинную подпись к цитате на вторую строку", () => {
    const r = splitReply([
      "Thanks!",
      "",
      "On Fri, Sep 26, 2026 at 10:00 AM Very Long Company Name Limited <",
      "hello@company.example> wrote:",
      "",
      "> Hello!",
    ].join("\n"));
    expect(r.reply).toBe("Thanks!");
    expect(r.quote).toBe("Hello!");
  });

  it("Gmail по-русски: «пт, 26 сент. 2026 г. в 10:00, Компания <…>:»", () => {
    const r = splitReply("Спасибо, заберу завтра.\n\nпт, 26 сент. 2026 г. в 10:00, Компания <hello@company.example>:\n\n> Здравствуйте! Заказ готов.\n");
    expect(r.reply).toBe("Спасибо, заберу завтра.");
    expect(r.quote).toBe("Здравствуйте! Заказ готов.");
  });

  it("Яндекс Почта и Mail.ru", () => {
    expect(splitReply('Добрый день! Да, удобно.\n\n26.09.2026, 10:00, "Компания" <hello@company.example>:\n> Здравствуйте! Удобно ли завтра?').reply)
      .toBe("Добрый день! Да, удобно.");
    const mailru = splitReply("Спасибо, получил!\n \n \nПятница, 26 сентября 2026, 10:00 +06:00 от Компания <hello@company.example>:\n>\n>Здравствуйте! Счёт во вложении.");
    expect(mailru.reply).toBe("Спасибо, получил!");
    expect(mailru.quote).toBe("Здравствуйте! Счёт во вложении.");
  });

  it("Outlook по-русски: черта и шапка «От: / Отправлено: / Кому: / Тема:», подпись человека остаётся", () => {
    const r = splitReply([
      "Документы отправлю завтра.",
      "",
      "С уважением,",
      "Айгерим",
      "",
      "________________________________",
      "От: Компания <hello@company.example>",
      "Отправлено: 26 сентября 2026 г. 10:00",
      "Кому: client@example.com",
      "Тема: Документы",
      "",
      "Здравствуйте! Пришлите, пожалуйста, документы.",
    ].join("\r\n"));
    expect(r.reply).toBe("Документы отправлю завтра.\n\nС уважением,\nАйгерим");
    expect(r.quote).toBe("Здравствуйте! Пришлите, пожалуйста, документы.");
  });

  it("Outlook по-английски: «-----Original Message-----» и шапка без черты", () => {
    expect(splitReply("Thanks!\n\n-----Original Message-----\nFrom: Company <hello@company.example>\nSent: Friday, September 26, 2026 10:00 AM\nTo: client@example.com\nSubject: Order\n\nHello, your order is ready.").reply)
      .toBe("Thanks!");
    const r = splitReply("Got it.\n\nFrom: Company <hello@company.example>\nSent: Friday, September 26, 2026 10:00 AM\nTo: client@example.com\nSubject: Order\n\nHello.");
    expect(r).toEqual({ reply: "Got it.", quote: "Hello." });
  });

  it("Apple Mail (подпись к цитате тоже с «>») и Thunderbird («… пишет:»)", () => {
    expect(splitReply("Спасибо!\n\n> 26 сент. 2026 г., в 10:00, Компания <hello@company.example> написал(а):\n> \n> Здравствуйте!").reply).toBe("Спасибо!");
    expect(splitReply("Спасибо!\n\n26.09.2026 10:00, Компания пишет:\n> Здравствуйте!").reply).toBe("Спасибо!");
  });

  it("подпись после «-- » и хвосты почты на телефоне — долой", () => {
    expect(splitReply("Буду в 10.\n\n-- \nАйгерим\nменеджер").reply).toBe("Буду в 10.");
    expect(splitReply("Да, подходит.\n\nОтправлено из мобильной Почты Mail.ru").reply).toBe("Да, подходит.");
    expect(splitReply("OK\n\nSent from my iPhone\n").reply).toBe("OK");
  });

  it("ответ снизу и вперемешку с цитатой — строки «>» убраны, ответ цел", () => {
    const bottom = splitReply("On Fri, Sep 26, 2026 at 10:00 AM Company <hello@company.example> wrote:\n> Когда вам удобно?\n\nЗавтра в 10.");
    expect(bottom).toEqual({ reply: "Завтра в 10.", quote: "Когда вам удобно?" });
    const mixed = splitReply("Здравствуйте!\n\nOn Fri, Sep 26, 2026 at 10:00 AM Company <hello@company.example> wrote:\n> Когда вам удобно?\nЗавтра в 10.\n> Какой адрес?\nЦентр города.");
    expect(mixed.reply).toBe("Здравствуйте!\n\nЗавтра в 10.\nЦентр города.");
  });

  it("пересланное письмо — это содержание: не режем", () => {
    const text = "Посмотрите, пожалуйста.\n\n---------- Forwarded message ---------\nFrom: Банк <no-reply@bank.example>\nDate: Fri, Sep 26, 2026 at 10:00 AM\nSubject: Выписка\nTo: <client@example.com>\n\nВаша выписка готова.";
    const r = splitReply(text);
    expect(r.reply).toContain("Посмотрите, пожалуйста.");
    expect(r.reply).toContain("Ваша выписка готова.");
    // Тема «Fwd:» / «Пересл.:» — письмо целиком (Outlook пересылает без отметки)
    const fw = "Смотрите ниже.\n\nFrom: Банк <no-reply@bank.example>\nSent: Friday, September 26, 2026 10:00 AM\nTo: client@example.com\nSubject: Выписка\n\nВаша выписка готова.";
    expect(splitReply(fw, { forward: true }).reply).toContain("Ваша выписка готова.");
    expect(isForwardSubject("Fwd: Выписка")).toBe(true);
    expect(isForwardSubject("Пересл.: Выписка")).toBe(true);
    expect(isForwardSubject("Re: Выписка")).toBe(false);
  });

  it("обычное письмо не трогаем; письмо из одной цитаты — пустой ответ (подключение возьмёт текст целиком)", () => {
    expect(splitReply("Здравствуйте!\nПодскажите цену.\n\nСпасибо").reply).toBe("Здравствуйте!\nПодскажите цену.\n\nСпасибо");
    expect(splitReply("> Hello\n> there").reply).toBe("");
    // «Менеджер написал:» без даты и адреса — не подпись к цитате
    expect(splitReply("Вчера менеджер написал:\nвсё готово.").reply).toBe("Вчера менеджер написал:\nвсё готово.");
  });
});

describe("HTML → текст", () => {
  it("абзацы, переносы, сущности", () => {
    expect(htmlToText("<p>Первый абзац</p><p>Второй<br>строка</p>")).toBe("Первый абзац\n\nВторой\nстрока");
    expect(htmlToText("&laquo;Привет&raquo; &amp; &#1087;ока&nbsp;!")).toBe("«Привет» & пока !");
    expect(decodeEntities("&unknown; &#x41; &copy")).toBe("&unknown; A &copy");
    expect(decodeEntities("&constructor;")).toBe("&constructor;");
  });

  it("ссылки «текст (адрес)»; адрес текстом, почта и ссылка-картинка — без повторов", () => {
    expect(htmlToText('Смотрите <a href="https://shop.example/order/1">ваш заказ</a>.')).toBe("Смотрите ваш заказ (https://shop.example/order/1).");
    expect(htmlToText('<a href="https://shop.example/">https://shop.example</a>')).toBe("https://shop.example");
    expect(htmlToText('Пишите: <a href="mailto:hello@company.example">hello@company.example</a>')).toBe("Пишите: hello@company.example");
    expect(htmlToText('<a href="mailto:hello@company.example?subject=x">нам</a>')).toBe("нам (hello@company.example)");
    expect(htmlToText('<p>Текст</p><a href="https://social.example/company"><img src="https://cdn.example/icon.png"></a>')).toBe("Текст");
    expect(htmlToText('<a href="javascript:alert(1)">нажми</a>')).toBe("нажми");
  });

  it("стили, скрипты, заголовок страницы и комментарии Outlook — мимо", () => {
    const html = "<html><head><title>Письмо</title><style>p { color: red }</style></head><body><!--[if mso]><p>только Outlook</p><![endif]--><script>alert(1)</script><p>Текст</p></body></html>";
    expect(htmlToText(html)).toBe("Текст");
  });

  it("списки и таблицы", () => {
    expect(htmlToText("<p>Список:</p><ul><li>Один</li><li>Два</li></ul><ol><li>Раз</li><li>Два</li></ol>")).toBe("Список:\n\n- Один\n- Два\n\n1. Раз\n2. Два");
    expect(htmlToText("<table><tr><td>Товар</td><td>Цена</td></tr><tr><td>Чай</td><td>100</td></tr></table>")).toBe("Товар Цена\nЧай 100");
  });

  it("цитата Gmail — строками «>», и ответ отделяется от неё", () => {
    const html = '<div dir="ltr">Добрый день!<div>Когда будет готов заказ?</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">пт, 26 сент. 2026 г. в 10:00, Компания &lt;<a href="mailto:hello@company.example">hello@company.example</a>&gt;:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Здравствуйте! Ваш заказ принят.</div></blockquote></div>';
    const text = htmlToText(html);
    expect(text).toContain("> Здравствуйте! Ваш заказ принят.");
    expect(splitReply(text)).toEqual({ reply: "Добрый день!\nКогда будет готов заказ?", quote: "Здравствуйте! Ваш заказ принят." });
  });

  it("Outlook в HTML: шапка прошлого письма жирным — тоже отрезается", () => {
    const html = '<div>Спасибо, всё получил.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><font face="Calibri"><b>От:</b> Компания &lt;hello@company.example&gt;<br><b>Отправлено:</b> 26 сентября 2026 г. 10:00<br><b>Кому:</b> client@example.com<br><b>Тема:</b> Счёт</font></div><div>Здравствуйте! Счёт во вложении.</div>';
    expect(splitReply(htmlToText(html)).reply).toBe("Спасибо, всё получил.");
  });

  it("Mail.ru: подпись к цитате внутри blockquote", () => {
    const html = '<div>Спасибо, получил!</div><div>&nbsp;</div><blockquote style="border-left:1px solid #0857A6; margin:10px; padding:0 0 0 10px;">Пятница, 26 сентября 2026, 10:00 +06:00 от Компания &lt;hello@company.example&gt;:<br>&nbsp;<div><div>Здравствуйте! Счёт во вложении.</div></div></blockquote>';
    expect(splitReply(htmlToText(html)).reply).toBe("Спасибо, получил!");
  });
});

describe("тема и заголовки", () => {
  it("тема ответа: «Re: …» один раз; пусто — тема по умолчанию", () => {
    expect(replySubject("Вопрос по заказу")).toBe("Re: Вопрос по заказу");
    expect(replySubject("RE: Вопрос")).toBe("RE: Вопрос");
    expect(replySubject("Ответ: Вопрос")).toBe("Ответ: Вопрос");
    expect(replySubject("  ")).toBe(DEFAULT_SUBJECT);
    expect(replySubject(null, "Письмо от компании")).toBe("Письмо от компании");
  });

  it("закодированные заголовки: base64 и quoted-printable, utf-8 и windows-1251", () => {
    expect(decodeMimeWords("=?UTF-8?B?0J/RgNC40LLQtdGC?=")).toBe("Привет");
    expect(decodeMimeWords("=?UTF-8?B?0J/RgNC4?= =?UTF-8?B?0LLQtdGC?=, мир")).toBe("Привет, мир");
    expect(decodeMimeWords("=?utf-8?Q?=D0=9F=D1=80=D0=B8_=D0=B2?=")).toBe("При в");
    expect(decodeMimeWords("=?windows-1251?B?z/Do4uXy?=")).toBe("Привет");
    expect(decodeMimeWords("Обычная тема")).toBe("Обычная тема");
  });
});

describe("HTML ответа клиенту", () => {
  it("текст человека: как набран, всё экранировано, адреса — ссылками (точка в конце — не часть адреса)", () => {
    const html = mailHtml("Привет <b>&\nсчёт: https://pay.example/a.pdf.\n\nВторой абзац");
    expect(html).toContain("<p style=\"margin:0 0 12px\">Привет &lt;b&gt;&amp;<br>\nсчёт: <a href=\"https://pay.example/a.pdf\">https://pay.example/a.pdf</a>.</p>");
    expect(html).toContain("Второй абзац</p>");
    expect(html).not.toContain("<b>");
  });

  it("ответ бота: разметка Markdown → теги письма", () => {
    const html = mailHtml("# Заказ\n**Важно**: оплатите [по ссылке](https://pay.example/1) до *пятницы*.\n* пункт <x>", { markdown: true });
    expect(html).toContain("<b>Заказ</b>");
    expect(html).toContain("<b>Важно</b>: оплатите <a href=\"https://pay.example/1\">по ссылке</a> до <i>пятницы</i>.");
    expect(html).toContain("- пункт &lt;x&gt;");
  });
});
