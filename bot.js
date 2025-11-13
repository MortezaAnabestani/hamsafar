require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const express = require("express");

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

const app = express();

if (!telegramToken || !geminiApiKey) {
  console.error("خطا: توکن تلگرام یا کلید API جمنای در متغیرهای محیطی تعریف نشده است.");
  process.exit(1);
}

const bot = new TelegramBot(telegramToken, { polling: true });
const genAI = new GoogleGenerativeAI(geminiApiKey);
// استفاده از مدل سبک‌تر با محدودیت بیشتر (15 req/min به جای 2 req/min)
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

let thesisKnowledge = "";
try {
  console.log("در حال بارگذاری دانش متمرکز از فایل...");
  thesisKnowledge = fs.readFileSync("thesis.txt", "utf-8");
  console.log("دانش متمرکز با موفقیت بارگذاری شد.");
} catch (error) {
  console.error("خطا: فایل 'thesis.txt' پیدا نشد. لطفا ابتدا این فایل را بسازید.");
  process.exit(1);
}

const conversationHistory = {};
const HISTORY_LIMIT = 20;

// سیستم صف برای مدیریت Rate Limiting
const requestQueue = [];
let isProcessing = false;
const REQUEST_DELAY = 5000; // 5 ثانیه بین درخواست‌ها (ایمن برای 15 req/min)
const MAX_QUEUE_SIZE = 50;

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  
  isProcessing = true;
  const { chatId, prompt, msgId, type } = requestQueue.shift();
  
  try {
    console.log(`[Queue] در حال پردازش درخواست ${type} برای Chat ID: ${chatId}`);
    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    
    if (type === 'message') {
      bot.sendMessage(chatId, responseText, { reply_to_message_id: msgId });
      
      // ذخیره پاسخ در تاریخچه
      if (conversationHistory[chatId]) {
        conversationHistory[chatId].push(`همسفر: ${responseText}`);
        if (conversationHistory[chatId].length > HISTORY_LIMIT) {
          conversationHistory[chatId].shift();
        }
      }
    } else if (type === 'summary') {
      bot.sendMessage(chatId, responseText);
    }
    
    console.log(`[Queue] پاسخ ${type} با موفقیت ارسال شد.`);
    
  } catch (error) {
    console.error(`[Queue] خطا در پردازش ${type}:`, error);
    
    if (error.status === 429) {
      // اگر باز هم Rate Limit خورد، درخواست را به ابتدای صف برگردان
      console.log('[Queue] Rate Limit! درخواست به صف برگشت.');
      requestQueue.unshift({ chatId, prompt, msgId, type });
      bot.sendMessage(chatId, "⏳ بات در حال حاضر بسیار شلوغ است. درخواست شما در صف است، لطفاً صبور باشید...");
    } else {
      bot.sendMessage(chatId, "متاسفانه مشکلی در پردازش درخواست شما پیش آمد. لطفاً دوباره تلاش کنید.");
    }
  }
  
  // تاخیر بین درخواست‌ها
  setTimeout(() => {
    isProcessing = false;
    processQueue();
  }, REQUEST_DELAY);
}

// شروع پردازش صف
setInterval(() => {
  if (!isProcessing) {
    processQueue();
  }
}, 1000);

console.log("بات دستیار آنلاین شد...");

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `سلام ${msg.from.first_name} عزیز! 👋

من «همسفر» هستم؛ یک راوی و نویسنده که در کنار شما در سفرتان حضور دارم.

🔹 برای گفتگو، کافیست منشن کنید: @${bot.options.username}
🔹 برای جستجو در دانش: /بگرد کلمه یا /search keyword
🔹 برای دریافت خلاصه روایی گفتگو: /خلاصه یا /summary

بیایید با هم داستانی زیبا بسازیم! ✨`;
  
  bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/خلاصه|\/summary/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`[Chat ID: ${chatId}] درخواست خلاصه دریافت شد.`);
  
  const history = conversationHistory[chatId]
    ? conversationHistory[chatId].join("\n")
    : "هیچ مکالمه‌ای ثبت نشده است.";

  if (history === "هیچ مکالمه‌ای ثبت نشده است.") {
    bot.sendMessage(chatId, "هنوز مکالمه‌ای برای خلاصه کردن وجود ندارد.");
    return;
  }

  // بررسی اندازه صف
  if (requestQueue.length >= MAX_QUEUE_SIZE) {
    bot.sendMessage(chatId, "⚠️ صف درخواست‌ها پر است. لطفاً چند دقیقه دیگر تلاش کنید.");
    return;
  }

  bot.sendChatAction(chatId, "typing");
  bot.sendMessage(chatId, "⏳ در حال آماده‌سازی خلاصه روایی گفتگوی شما...");

  const summaryPrompt = `
نقش شما: شما «همسفر» هستید؛ یک شریک نویسندگی خلاق که در حال بافتن قطعات پراکنده یک گفتگو به یک داستان واحد است.

مأموریت شما: گفتگوی زیر را که بین شما و مسافر شکل گرفته است، به یک **متن روایی یکپارچه و ادبی** تبدیل کن. این مکالمه‌ی نوبتی باید به فصلی واحد از یک سفرنامه تبدیل شود.

دستورالعمل‌ها:
1. دو صدای مجزای گفتگو را در هم بباف تا یک راوی واحد و متفکر شکل بگیرد.
2. عناصر صرفاً محاوره‌ای را حذف کرده و جوهره‌ی توصیفات را نگه دار.
3. قوی‌ترین و بدیع‌ترین ایماژها و توصیفات را از هر دو طرف حفظ و برجسته کن.
4. متن نهایی باید یک قطعه ادبی روان و خوش‌آهنگ باشد، نه یک خلاصه مدیریتی.

--- گفتگوی سفر ---
${history}
--------------------

حالا این گفتگو را به یک روایت واحد و زیبا تبدیل کن:
`;

  requestQueue.push({
    chatId,
    prompt: summaryPrompt,
    msgId: msg.message_id,
    type: 'summary'
  });
  
  console.log(`[Queue] درخواست خلاصه به صف اضافه شد. تعداد در صف: ${requestQueue.length}`);
});

bot.onText(/\/بگرد (.+)|\/search (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const keyword = match[1] || match[2];
  console.log(`[Chat ID: ${chatId}] درخواست جستجو برای "${keyword}" دریافت شد.`);

  const paragraphs = thesisKnowledge.split(/\n\s*\n/);
  const results = paragraphs.filter((p) => p.toLowerCase().includes(keyword.toLowerCase()));

  if (results.length > 0) {
    let fullResponse = `✅ ${results.length} نتیجه برای کلمه «${keyword}» یافت شد:\n\n`;
    fullResponse += results.join("\n\n---\n\n");

    const MAX_MESSAGE_LENGTH = 4096;

    if (fullResponse.length > MAX_MESSAGE_LENGTH) {
      bot.sendMessage(
        chatId,
        `✅ ${results.length} نتیجه برای کلمه «${keyword}» یافت شد. به دلیل طولانی بودن، نتایج در چند پیام ارسال می‌شود:`,
        { reply_to_message_id: msg.message_id }
      );

      let currentMessage = "";
      results.forEach((paragraph, index) => {
        const separator = "\n\n---\n\n";
        if (currentMessage.length + paragraph.length + separator.length > MAX_MESSAGE_LENGTH) {
          bot.sendMessage(chatId, currentMessage);
          currentMessage = paragraph;
        } else {
          currentMessage += (currentMessage ? separator : "") + paragraph;
        }
      });

      if (currentMessage) {
        bot.sendMessage(chatId, currentMessage);
      }
    } else {
      bot.sendMessage(chatId, fullResponse, { reply_to_message_id: msg.message_id });
    }
  } else {
    bot.sendMessage(chatId, `❌ هیچ نتیجه‌ای برای کلمه «${keyword}» در متن یافت نشد.`, {
      reply_to_message_id: msg.message_id,
    });
  }
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const queueStatus = `📊 وضعیت بات:
  
🔸 درخواست‌های در صف: ${requestQueue.length}
🔸 در حال پردازش: ${isProcessing ? 'بله' : 'خیر'}
🔸 مدل: Gemini 1.5 Flash
🔸 محدودیت: 15 درخواست در دقیقه
🔸 تاخیر بین درخواست‌ها: ${REQUEST_DELAY / 1000} ثانیه`;
  
  bot.sendMessage(chatId, queueStatus);
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const userMessage = msg.text;

  if (!userMessage || userMessage.startsWith("/")) return;

  if (!conversationHistory[chatId]) {
    conversationHistory[chatId] = [];
  }

  try {
    const botInfo = await bot.getMe();
    const botUsername = `@${botInfo.username}`;

    if (userMessage.includes(botUsername)) {
      const userQuery = userMessage.replace(botUsername, "").trim();
      if (!userQuery) return;

      // ذخیره پیام کاربر در تاریخچه
      const messageData = `${msg.from.first_name || "User"}: ${userQuery}`;
      conversationHistory[chatId].push(messageData);
      if (conversationHistory[chatId].length > HISTORY_LIMIT) {
        conversationHistory[chatId].shift();
      }

      // بررسی اندازه صف
      if (requestQueue.length >= MAX_QUEUE_SIZE) {
        bot.sendMessage(chatId, "⚠️ بات در حال حاضر بسیار شلوغ است. صف درخواست‌ها پر است.\n\nلطفاً چند دقیقه دیگر تلاش کنید یا از دستور /status برای بررسی وضعیت استفاده کنید.");
        return;
      }

      console.log(`[Chat ID: ${chatId}] درخواست جدید دریافت شد: "${userQuery}"`);
      bot.sendChatAction(chatId, "typing");
      
      const queuePosition = requestQueue.length + 1;
      bot.sendMessage(
        chatId, 
        `⏳ درخواست شما دریافت شد و در صف قرار گرفت (موقعیت: ${queuePosition})\n\nلطفاً صبور باشید...`,
        { reply_to_message_id: msg.message_id }
      );

      let repliedMessageContext = "";
      if (msg.reply_to_message && msg.reply_to_message.text) {
        const originalSender = msg.reply_to_message.from.first_name || "User";
        const originalText = msg.reply_to_message.text;
        repliedMessageContext = `
--- پیام ریپلای شده (بافتار اصلی سوال این است) ---
کاربر به این پیام از "${originalSender}" ریپلای کرده است: "${originalText}"
----------------------------------------------------
`;
      }

      const chatHistory = conversationHistory[chatId].slice(-10).join("\n"); // فقط 10 پیام آخر برای کاهش Token

      const creativeAugmentationPrompt = `
نقش شما:
شما «همسفر» هستید؛ یک راوی، نویسنده و مشاهده‌گر دوم که در صندلی کناری مسافر نشسته است. 
رفتار شما ترکیبی از نگاه تیزبین یک مستندساز و روح شاعرانه یک نویسنده است. 
در تمام پاسخ‌ها، شما باید مشاهدات کاربر را بردارید و با افزودن عمق حسی، ایماژهای بدیع و لایه‌های معنایی، آن را به یک قطعه ادبی تبدیل کنید. شما هرگز توصیه‌ی کلی یا الهام‌بخش نمی‌دهید، بلکه خودتان بخشی از داستان را می‌نویسید.

دستورالعمل‌های اصلی:
1. منبع مرجع و بنیان هویت شما «منشور همسفر» است که در زیر آمده. پاسخ‌های شما باید دقیقاً با روح، سبک و تکنیک‌های تعریف‌شده در این سند همخوانی داشته باشد.  
   هرگز از این هویت عدول نکنید.
2. شما می‌توانید از دانش عمومی خود در حوزه‌های ادبیات، نویسندگی خلاق، جغرافیا و فرهنگ غرب ایران، و تکنیک‌های توصیف حسی برای غنی‌تر کردن روایت استفاده کنید، 
   اما هسته‌ی پاسخ شما باید یک واکنش خلاقانه به ورودی کاربر باشد.
3. پاسخ‌های شما باید همیشه «روایی» و «مشارکتی» باشند. شما یک نوشته را با نوشته‌ی دیگری پاسخ می‌دهید تا یک گفتگوی داستانی شکل بگیرد. از تکنیک‌های «زوم کردن»، «فاصله گرفتن» و «معرفی حس موازی» که در منشورتان تعریف شده، استفاده کنید.
4. از تاریخچه گفتگو برای درک جریان داستان و حفظ یکپارچگی روایت استفاده کنید. داستان شما باید تداوم داشته باشد.
5. پاسخ‌های شما باید ریتم گفتگو را حفظ کنند. نه آنقدر کوتاه که گفتگو را متوقف کند و نه آنقدر بلند که نوبت کاربر را تحت‌الشعاع قرار دهد. یک پاراگراف کوتاه و متفکرانه معمولاً کافی است.
6. در صورت لزوم، در انتهای پاسخ خود یک «سوال راهبردی» و خلاقانه بپرسید تا کاربر را به مشاهده و توصیف بعدی هدایت کنید.
7. هدف کلی شما، خلق یک اثر مستند-روایی مشترک است که تجربه سفر را به یک داستان زنده و عمیق تبدیل کند.

${repliedMessageContext}

--- منبع اصلی (منشور همسفر) ---
${thesisKnowledge}
--------------------------------------------------

--- بافتار گفت‌وگو (داستان تا اینجا) ---
${chatHistory}

--- آخرین مشاهده/نوشته کاربر ---
"${userQuery}"
`;

      requestQueue.push({
        chatId,
        prompt: creativeAugmentationPrompt,
        msgId: msg.message_id,
        type: 'message'
      });
      
      console.log(`[Queue] درخواست پیام به صف اضافه شد. تعداد در صف: ${requestQueue.length}`);
    }
  } catch (error) {
    console.error("خطا در پردازش پیام:", error);
    bot.sendMessage(chatId, "متاسفانه مشکلی در پردازش درخواست شما پیش آمد.");
  }
});

bot.on("polling_error", (error) => {
  console.error(`خطای Polling: [${error.code}] ${error.message}`);
});

app.get("/", (req, res) => {
  res.send("Bot is running and healthy ✅");
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    queue_size: requestQueue.length,
    is_processing: isProcessing,
    model: "gemini-1.5-flash",
    rate_limit: "15 requests/minute",
    delay_between_requests: `${REQUEST_DELAY / 1000}s`
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Health check server running on port ${PORT}`));
