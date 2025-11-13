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
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

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

// ================== سیستم Token Bucket برای Rate Limiting ==================
class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity; // ظرفیت کل
    this.tokens = capacity; // توکن‌های فعلی
    this.refillRate = refillRate; // تعداد توکن در هر ثانیه
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000; // به ثانیه
    const tokensToAdd = timePassed * this.refillRate;
    
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }

  async consume(tokens = 1) {
    this.refill();
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    
    // محاسبه زمان انتظار
    const tokensNeeded = tokens - this.tokens;
    const waitTime = (tokensNeeded / this.refillRate) * 1000;
    
    console.log(`[Token Bucket] در انتظار ${Math.ceil(waitTime / 1000)} ثانیه...`);
    await new Promise(resolve => setTimeout(resolve, waitTime));
    
    this.refill();
    this.tokens -= tokens;
    return true;
  }

  getStatus() {
    this.refill();
    return {
      available: Math.floor(this.tokens),
      capacity: this.capacity
    };
  }
}

// ایجاد Token Bucket با محدودیت 15 درخواست در دقیقه
// به صورت محافظه‌کارانه: 10 توکن با refill 0.15 توکن در ثانیه (9 در دقیقه)
const rateLimiter = new TokenBucket(10, 0.15);

// ================== تابع Retry با Exponential Backoff ==================
async function callGeminiWithRetry(prompt, maxRetries = 5) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // منتظر دریافت توکن می‌مانیم
      await rateLimiter.consume(1);
      
      console.log(`[Gemini] تلاش ${attempt}/${maxRetries} - توکن‌های باقیمانده: ${rateLimiter.getStatus().available}`);
      
      const result = await model.generateContent(prompt);
      const responseText = result.response.text();
      
      console.log(`[Gemini] پاسخ با موفقیت دریافت شد.`);
      return { success: true, text: responseText };
      
    } catch (error) {
      console.error(`[Gemini] خطا در تلاش ${attempt}:`, error.message);
      
      if (error.status === 429) {
        // استخراج زمان انتظار از پاسخ API
        let retryAfter = 60; // پیش‌فرض: 60 ثانیه
        
        if (error.errorDetails) {
          const retryInfo = error.errorDetails.find(d => d['@type']?.includes('RetryInfo'));
          if (retryInfo && retryInfo.retryDelay) {
            const delayMatch = retryInfo.retryDelay.match(/(\d+)/);
            if (delayMatch) {
              retryAfter = parseInt(delayMatch[1]);
            }
          }
        }
        
        const backoffTime = retryAfter * 1000 * Math.pow(2, attempt - 1); // Exponential backoff
        const waitTime = Math.min(backoffTime, 300000); // حداکثر 5 دقیقه
        
        console.log(`[Gemini] Rate Limit! انتظار ${Math.ceil(waitTime / 1000)} ثانیه...`);
        
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, waitTime));
        } else {
          return { 
            success: false, 
            error: 'Rate limit exceeded after multiple retries',
            retryAfter: Math.ceil(waitTime / 1000)
          };
        }
      } else {
        // خطاهای غیر از Rate Limit
        return { 
          success: false, 
          error: error.message || 'Unknown error'
        };
      }
    }
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

console.log("بات دستیار آنلاین شد...");

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `سلام ${msg.from.first_name} عزیز! 👋

من «همسفر» هستم؛ یک راوی و نویسنده که در کنار شما در سفرتان حضور دارم.

🔹 برای گفتگو، کافیست منشن کنید: @${bot.options.username}
🔹 برای جستجو در دانش: /بگرد کلمه یا /search keyword
🔹 برای دریافت خلاصه روایی گفتگو: /خلاصه یا /summary
🔹 برای بررسی وضعیت بات: /status

⚠️ توجه: به دلیل محدودیت API، ممکن است پاسخ‌ها کمی زمان‌بر باشند.

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

  bot.sendChatAction(chatId, "typing");
  const statusMsg = await bot.sendMessage(chatId, "⏳ در حال آماده‌سازی خلاصه روایی... این ممکن است چند لحظه طول بکشد.");

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

  const result = await callGeminiWithRetry(summaryPrompt);
  
  await bot.deleteMessage(chatId, statusMsg.message_id);
  
  if (result.success) {
    bot.sendMessage(chatId, result.text);
  } else {
    if (result.retryAfter) {
      bot.sendMessage(chatId, `⚠️ بات در حال حاضر بسیار شلوغ است. لطفاً ${result.retryAfter} ثانیه دیگر دوباره تلاش کنید.`);
    } else {
      bot.sendMessage(chatId, `❌ متاسفانه در خلاصه کردن مکالمات مشکلی پیش آمد: ${result.error}`);
    }
  }
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
  const bucketStatus = rateLimiter.getStatus();
  
  const queueStatus = `📊 وضعیت بات:
  
🔸 توکن‌های موجود: ${bucketStatus.available}/${bucketStatus.capacity}
🔸 مدل: gemini-2.5-pro
🔸 محدودیت: ~9 درخواست در دقیقه (محافظه‌کارانه)
🔸 Retry: فعال با Exponential Backoff

✅ بات آماده دریافت درخواست است.`;
  
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

      console.log(`[Chat ID: ${chatId}] درخواست جدید دریافت شد: "${userQuery}"`);
      bot.sendChatAction(chatId, "typing");
      
      const statusMsg = await bot.sendMessage(
        chatId, 
        `⏳ در حال پردازش درخواست شما...\n\nتوکن‌های موجود: ${rateLimiter.getStatus().available}`,
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

      const chatHistory = conversationHistory[chatId].slice(-10).join("\n");

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

      const result = await callGeminiWithRetry(creativeAugmentationPrompt);
      
      await bot.deleteMessage(chatId, statusMsg.message_id);
      
      if (result.success) {
        bot.sendMessage(chatId, result.text, { reply_to_message_id: msg.message_id });
        
        // ذخیره پاسخ در تاریخچه
        conversationHistory[chatId].push(`همسفر: ${result.text}`);
        if (conversationHistory[chatId].length > HISTORY_LIMIT) {
          conversationHistory[chatId].shift();
        }
        
        console.log(`[Chat ID: ${chatId}] پاسخ تخصصی ارسال شد.`);
      } else {
        if (result.retryAfter) {
          bot.sendMessage(chatId, `⚠️ بات در حال حاضر بسیار شلوغ است. لطفاً ${result.retryAfter} ثانیه دیگر دوباره تلاش کنید.`);
        } else {
          bot.sendMessage(chatId, `❌ متاسفانه در پردازش درخواست شما مشکلی پیش آمد: ${result.error}`);
        }
      }
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
  const bucketStatus = rateLimiter.getStatus();
  res.json({
    status: "ok",
    tokens_available: bucketStatus.available,
    tokens_capacity: bucketStatus.capacity,
    model: "gemini-2.5-pro",
    rate_limit: "~9 requests/minute (conservative)"
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => console.log(`Health check server running on port ${PORT}`));
