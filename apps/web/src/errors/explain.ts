import { text } from "../i18n";
import type { Language } from "../store";

/**
 * What a raw failure means to the person who hit it: one short reason, what might have caused
 * it, what to do — in the interface language. The raw text (an exception's own English message,
 * "Failed to fetch") is kept, but only as the folded technical detail.
 *
 * A table, not a chain of `if`s in each dialog: every error modal asks here, so a new kind of
 * failure is one row, and no call site can drift into showing the raw message again.
 */
export interface ErrorExplanation {
  readonly reason: string;
  readonly causes: readonly string[];
  readonly remedies: readonly string[];
  readonly technical: string;
}

interface Pair { readonly en: string; readonly ru: string }
interface Rule {
  readonly test: RegExp;
  readonly reason: Pair;
  readonly causes: readonly Pair[];
  readonly remedies: readonly Pair[];
}

const RULES: readonly Rule[] = [
  {
    test: /failed to fetch|networkerror|load failed|network request failed|err_internet|err_network|net::/i,
    reason: { en: "Could not download the required data.", ru: "Не удалось скачать нужные данные." },
    causes: [
      { en: "No internet connection", ru: "Нет подключения к интернету" },
      { en: "The server is unreachable or blocked (VPN, firewall, ad blocker)", ru: "Сервер недоступен или заблокирован (VPN, брандмауэр, блокировщик рекламы)" },
      { en: "The file host does not allow downloads from this page (CORS)", ru: "Хостинг файла не разрешает загрузку с этой страницы (CORS)" },
    ],
    remedies: [
      { en: "Check the connection and try again", ru: "Проверьте подключение и повторите" },
      { en: "Turn off the VPN or blocker for this page", ru: "Отключите VPN или блокировщик для этой страницы" },
    ],
  },
  {
    test: /\b(404|not found)\b/i,
    reason: { en: "The file was not found on the server.", ru: "Файл не найден на сервере." },
    causes: [{ en: "The file was moved or removed by its host", ru: "Файл перемещён или удалён владельцем хостинга" }],
    remedies: [{ en: "Try another model in the settings, or update the application", ru: "Выберите другую модель в настройках или обновите приложение" }],
  },
  {
    test: /\b(401|403)\b|forbidden|unauthori[sz]ed/i,
    reason: { en: "The server refused access.", ru: "Сервер отказал в доступе." },
    causes: [
      { en: "The file requires sign-in or a key", ru: "Файл требует входа или ключа" },
      { en: "The API key is wrong or expired", ru: "Ключ API неверен или истёк" },
    ],
    remedies: [{ en: "Check the key in the settings", ru: "Проверьте ключ в настройках" }],
  },
  {
    test: /\b5\d\d\b|service unavailable|bad gateway|gateway timeout/i,
    reason: { en: "The server is having problems.", ru: "Сервер сейчас работает с ошибками." },
    causes: [{ en: "Temporary outage on the host's side", ru: "Временный сбой на стороне хостинга" }],
    remedies: [{ en: "Try again in a few minutes", ru: "Повторите через несколько минут" }],
  },
  {
    test: /quota|storage.*full|no space/i,
    reason: { en: "Not enough storage space.", ru: "Недостаточно места в хранилище." },
    causes: [
      { en: "The browser's storage for this site is full", ru: "Хранилище браузера для этого сайта заполнено" },
      { en: "The disk is almost full", ru: "Диск почти заполнен" },
    ],
    remedies: [
      { en: "Free disk space or remove cached models", ru: "Освободите место на диске или удалите закэшированные модели" },
    ],
  },
  {
    test: /out of memory|array buffer allocation|allocation failed|invalid array length|oom|bad_alloc|cannot allocate/i,
    reason: { en: "Not enough memory for this operation.", ru: "Не хватило памяти для этой операции." },
    causes: [
      { en: "The image or layer is too large", ru: "Изображение или слой слишком большие" },
      { en: "Other tabs and programs are using the memory", ru: "Память занята другими вкладками и программами" },
    ],
    remedies: [
      { en: "Close other tabs and programs and try again", ru: "Закройте другие вкладки и программы и повторите" },
      { en: "Work on a smaller selection or reduce the image size", ru: "Работайте с меньшим выделением или уменьшите изображение" },
    ],
  },
  {
    test: /webgpu|webgl|gpu.*(not|un)available|no available backend|backend.*not/i,
    reason: { en: "The graphics accelerator is unavailable.", ru: "Графический ускоритель недоступен." },
    causes: [
      { en: "The browser or driver does not support WebGPU/WebGL", ru: "Браузер или драйвер не поддерживает WebGPU/WebGL" },
      { en: "Hardware acceleration is turned off", ru: "Аппаратное ускорение выключено" },
    ],
    remedies: [
      { en: "Update the browser and video driver", ru: "Обновите браузер и видеодрайвер" },
      { en: "Turn on hardware acceleration in the browser settings", ru: "Включите аппаратное ускорение в настройках браузера" },
    ],
  },
  {
    test: /protobuf|onnx|failed to load model|invalid model|can't create a session|session.*creat/i,
    reason: { en: "The model file could not be read.", ru: "Не удалось прочитать файл модели." },
    causes: [
      { en: "The download was interrupted and the file is damaged", ru: "Загрузка прервалась, и файл повреждён" },
      { en: "The server returned a page instead of the model", ru: "Сервер вернул страницу вместо модели" },
    ],
    remedies: [{ en: "Remove the cached model in the settings and download it again", ru: "Удалите закэшированную модель в настройках и скачайте заново" }],
  },
  {
    test: /notallowed|permission|securityerror|denied/i,
    reason: { en: "The browser did not give permission.", ru: "Браузер не дал разрешение." },
    causes: [{ en: "Access was denied for this page", ru: "Доступ для этой страницы запрещён" }],
    remedies: [{ en: "Allow access in the address bar and try again", ru: "Разрешите доступ в адресной строке и повторите" }],
  },
  {
    test: /abort|cancel/i,
    reason: { en: "The operation was interrupted.", ru: "Операция была прервана." },
    causes: [{ en: "It was cancelled, or the page lost the connection", ru: "Её отменили, или страница потеряла соединение" }],
    remedies: [{ en: "Run it again", ru: "Запустите ещё раз" }],
  },
  {
    test: /timeout|timed out/i,
    reason: { en: "The operation took too long.", ru: "Операция заняла слишком много времени." },
    causes: [{ en: "Slow connection or a very large image", ru: "Медленное соединение или очень большое изображение" }],
    remedies: [{ en: "Try again, or on a smaller area", ru: "Повторите или попробуйте на меньшей области" }],
  },
];

const FALLBACK: Omit<Rule, "test"> = {
  reason: { en: "An unexpected error occurred.", ru: "Произошла непредвиденная ошибка." },
  causes: [{ en: "An internal problem of the application", ru: "Внутренняя ошибка приложения" }],
  remedies: [
    { en: "Try again", ru: "Повторите действие" },
    { en: "If it repeats, send the technical details below with your report", ru: "Если повторяется — приложите технические подробности ниже к сообщению об ошибке" },
  ],
};

export function rawErrorText(error: unknown): string {
  if (error instanceof Error) return error.name && error.name !== "Error" ? `${error.name}: ${error.message}` : error.message;
  return String(error);
}

export function explainError(error: unknown, language: Language): ErrorExplanation {
  const technical = rawErrorText(error);
  const rule = RULES.find((candidate) => candidate.test.test(technical)) ?? FALLBACK;
  const say = (pair: Pair) => text(language, pair.en, pair.ru);
  return { reason: say(rule.reason), causes: rule.causes.map(say), remedies: rule.remedies.map(say), technical };
}
