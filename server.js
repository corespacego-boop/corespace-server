const express = require("express");
const cors = require("cors");
const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORTAL_LOGIN_URL = "https://sp.srmist.edu.in/srmiststudentportal/students/loginManager/youLogin.jsp";
const PORTAL_BASE_URL = "https://sp.srmist.edu.in/srmiststudentportal";
const PORTAL_ATT_URL = PORTAL_BASE_URL + "/students/report/studentAttendanceDetails.jsp";
const PORTAL_MARKS_URL = PORTAL_BASE_URL + "/students/report/studentInternalMarkDetails.jsp";
const PORTAL_INNER_MARKS_URL = PORTAL_BASE_URL + "/students/report/studentInternalMarkDetailsInner.jsp";
const PORTAL_TIMETABLE_URL = PORTAL_BASE_URL + "/students/report/studentTimeTableDetails.jsp";
const PORTAL_PROFILE_URL = PORTAL_BASE_URL + "/students/report/studentPersonalDetails.jsp";
const PORTAL_LOGIN_SERVLET = PORTAL_BASE_URL + "/LoginServlet";

const DEFAULT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Referer": PORTAL_LOGIN_URL,
  "Origin": "https://sp.srmist.edu.in",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9"
};

// Cookie Jar implementation to persist session cookies across requests
class CookieJar {
  constructor(initialCookies = {}) {
    this.cookies = new Map(Object.entries(initialCookies));
  }

  updateFromHeaders(headers) {
    if (!headers) return;
    const setCookie = headers["set-cookie"];
    if (!setCookie) return;
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const str of cookieArray) {
      const parts = str.split(";")[0].split("=");
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join("=").trim();
        if (key && val) {
          this.cookies.set(key, val);
        }
      }
    }
  }

  toHeaderString() {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  toDict() {
    const obj = {};
    for (const [k, v] of this.cookies.entries()) {
      obj[k] = v;
    }
    return obj;
  }
}

// In-memory session store for portal captcha states (10 min TTL)
const SESSION_STORE = new Map();
const SESSION_TTL_MS = 10 * 60 * 1000;

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [id, data] of SESSION_STORE.entries()) {
    if (now - data.timestamp > SESSION_TTL_MS) {
      SESSION_STORE.delete(id);
    }
  }
}

function generateTelemetryPayload(userAgent) {
  const now = Date.now();
  const start = now - (Math.floor(Math.random() * 5000) + 3000);
  const seed = Math.floor(Math.random() * 0x7FFFFFFF);
  const canvasHash = seed.toString(16).padStart(6, "0");

  const payload = {
    startTime: start,
    currentDomain: "sp.srmist.edu.in",
    timezoneOffset: -330,
    screenWidth: 1366,
    screenHeight: 768,
    colorDepth: 24,
    devicePixelRatio: 1,
    platform: "Win32",
    userAgent: userAgent || DEFAULT_HEADERS["User-Agent"],
    language: "en-US",
    hardwareConcurrency: 8,
    deviceMemory: 8,
    touchSupport: false,
    webdriver: false,
    mouseClicks: Math.floor(Math.random() * 5) + 2,
    mouseMovements: Math.floor(Math.random() * 16) + 5,
    keystrokeCount: 0,
    typingSpeedMs: 0,
    canvasHash: canvasHash,
    submitTime: now,
    timeOnPageMs: now - start
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function classifyFailure(htmlBody) {
  if (!htmlBody) return { reason: "login_failed", message: "Login failed" };
  const $ = cheerio.load(htmlBody);
  const alertEl = $(".alert-icon-content, .alert-danger");

  if (alertEl.length > 0) {
    let alertText = alertEl.text().trim().replace(/\s+/g, " ");
    if (alertText.toLowerCase().startsWith("alert")) {
      alertText = alertText.substring(5).trim();
    }
    const blob = alertText.toLowerCase();
    if (blob.includes("invalid captcha") || blob.includes("captcha")) {
      return { reason: "wrong_captcha", message: alertText || "Invalid captcha." };
    }
    if (blob.includes("locked")) {
      return { reason: "account_locked", message: alertText };
    }
    if (
      blob.includes("invalid login credentials") ||
      blob.includes("attempts remaining") ||
      blob.includes("invalid") ||
      blob.includes("unsuccessful") ||
      blob.includes("user id or password")
    ) {
      return { reason: "invalid_credentials", message: alertText };
    }
    return { reason: "login_failed", message: alertText || "Login failed" };
  }

  const blob = htmlBody.toLowerCase();
  if (blob.includes("session") && (blob.includes("expire") || blob.includes("timeout"))) {
    return { reason: "session_expired", message: "Session expired, refresh and retry." };
  }
  return { reason: "login_failed", message: "Login failed" };
}

function parseAttendance(html) {
  const courses = [];
  const monthly = [];
  if (!html) return { courses, monthly };
  const $ = cheerio.load(html);

  $("table tr").each((_, tr) => {
    const cells = $(tr).find("td, th").map((_, el) => $(el).text().trim()).get();
    if (!cells || cells.length === 0) return;

    const firstCell = cells[0];
    if (/^[A-Z0-9]{6,12}$/.test(firstCell) && cells.length >= 6) {
      const conducted = parseInt(cells[2], 10);
      const present = parseInt(cells[3], 10);
      const absent = parseInt(cells[4], 10);
      const percent = parseFloat(cells[5]);
      if (!isNaN(conducted) && !isNaN(present) && !isNaN(absent) && !isNaN(percent)) {
        courses.push({
          code: firstCell,
          title: cells[1],
          category: "Theory",
          slot: "",
          conducted,
          absent,
          present,
          percent,
          isPortal: true
        });
      }
    } else if (/^[A-Za-z]{3}-\d{4}$/.test(firstCell) && cells.length >= 3) {
      const present = parseInt(cells[1], 10);
      const absent = parseInt(cells[2], 10);
      if (!isNaN(present) && !isNaN(absent)) {
        monthly.push({
          month: firstCell,
          present,
          absent
        });
      }
    }
  });

  courses.sort((a, b) => a.percent - b.percent || a.conducted - b.conducted);
  return { courses, monthly };
}

function parseProfile(html) {
  if (!html) return {};
  const $ = cheerio.load(html);
  const profile = {
    name: "",
    regNo: "Unknown",
    batch: "N/A",
    semester: "N/A",
    dept: "N/A",
    section: "N/A",
    mobile: "N/A",
    program: "N/A"
  };

  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length >= 2) {
      const label = $(tds[0]).text().trim().toLowerCase().replace(/\s+/g, " ");
      const val = $(tds[1]).text().trim().replace(/\s+/g, " ");
      if (label.includes("student name")) profile.name = val;
      else if (label.includes("register no")) profile.regNo = val;
      else if (label.includes("institution") || label.includes("department")) profile.dept = val;
      else if (label.includes("program")) profile.program = val;
      else if (label.includes("batch")) profile.batch = val;
      else if (label.includes("semester")) profile.semester = val;
      else if (label.includes("section")) profile.section = val;
      else if (label.includes("student mobile") || label.includes("mobile")) profile.mobile = val;
    }
  });
  return profile;
}

function parseTimetable(html) {
  if (!html) return { schedule: {}, coursesMap: {} };
  const $ = cheerio.load(html);
  const coursesMap = {};

  $("table").each((_, table) => {
    const headers = $(table).find("th").map((_, th) => $(th).text().trim().toLowerCase()).get();
    if (headers.some(h => h.includes("course code")) && headers.some(h => h.includes("faculty"))) {
      const rows = $(table).find("tbody tr").length > 0 ? $(table).find("tbody tr") : $(table).find("tr");
      rows.each((_, row) => {
        const cols = $(row).find("td").map((_, td) => $(td).text().replace(/\s+/g, " ").trim()).get();
        if (cols.length >= 5) {
          const cCode = cols[0];
          const cName = cols[1];
          const cCredits = cols[2];
          const cSlot = cols[3];
          const cFaculty = cols[4];

          const building = cols[5] || "";
          const floor = cols[6] || "";
          const rawRoom = cols[7] || "";

          let cleanRoom = "";
          if (rawRoom) {
            cleanRoom = rawRoom.split(/[,/]|(?:\s+(?:Drafting|Lab|Room|Hall))/i)[0].trim();
          }

          const bStr = building.trim();
          const mAbbr = bStr.match(/\(([^)]+)\)/);
          let bAbbr = "";
          if (mAbbr) {
            bAbbr = mAbbr[1].trim().toUpperCase();
          } else if (bStr) {
            bAbbr = bStr.split(/[\s-]+/).filter(w => w && /^[a-zA-Z0-9]/.test(w)).map(w => w[0].toUpperCase()).join("");
          }

          let fullRoom = "TBA";
          if (cleanRoom && bAbbr) {
            fullRoom = cleanRoom.toUpperCase().startsWith(bAbbr) ? cleanRoom : `${bAbbr} ${cleanRoom}`;
          } else if (cleanRoom) {
            fullRoom = cleanRoom;
          } else if (bAbbr) {
            fullRoom = bAbbr;
          }

          const isLab = cCode.endsWith("L") || cCode.endsWith("P") ||
            cName.toLowerCase().includes("lab") || cName.toLowerCase().includes("practical") ||
            cSlot.split(",").some(s => s.trim().toUpperCase().startsWith("P"));

          const courseInfo = {
            code: cCode,
            name: cName,
            title: cName,
            credits: cCredits,
            slot: cSlot,
            faculty: cFaculty || "TBA",
            room: fullRoom,
            building: building,
            floor: floor,
            room_name: cleanRoom,
            type: isLab ? "Practical" : "Theory",
            raw_type: isLab ? "Practical" : "Theory"
          };

          if (!coursesMap[cCode]) {
            coursesMap[cCode] = courseInfo;
          } else {
            if (cSlot && !coursesMap[cCode].slot.includes(cSlot)) {
              coursesMap[cCode].slot += `, ${cSlot}`;
            }
            if (fullRoom !== "TBA" && coursesMap[cCode].room === "TBA") {
              coursesMap[cCode].room = fullRoom;
            }
          }
        }
      });
    }
  });

  const schedule = {};
  let gridTable = null;
  const subjectTab = $("#subjectTab").length > 0 ? $("#subjectTab") : $("body");

  subjectTab.find("table").each((_, table) => {
    const txt = $(table).text().toLowerCase();
    if (txt.includes("from") || txt.includes("day 1") || txt.includes("08:00")) {
      gridTable = $(table);
      return false;
    }
  });

  if (gridTable) {
    let timeHeaders = [];
    const thead = gridTable.find("thead");
    if (thead.length > 0) {
      thead.find("tr").each((_, tr) => {
        const rowTimes = [];
        $(tr).find("th, td").each((_, cell) => {
          const raw = $(cell).text().replace(/\s+/g, " ").trim();
          const m = raw.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
          if (m) {
            rowTimes.push(`${m[1]} - ${m[2]}`);
          }
        });
        if (rowTimes.length > 0) {
          timeHeaders = rowTimes;
          return false;
        }
      });
    }

    const tbody = gridTable.find("tbody").length > 0 ? gridTable.find("tbody") : gridTable;
    tbody.find("tr").each((_, tr) => {
      const tds = $(tr).find("td");
      if (tds.length === 0) return;

      const dayText = $(tds[0]).text().replace(/\s+/g, " ").trim();
      const dayMatch = dayText.match(/Day\s*(\d+)/i);
      if (!dayMatch) return;

      const dayName = `Day ${dayMatch[1]}`;
      schedule[dayName] = {};

      tds.slice(1).each((i, td) => {
        if (i >= timeHeaders.length) return;
        const timeSlot = timeHeaders[i];
        const rawVal = $(td).text().replace(/\s+/g, " ").trim();
        if (!rawVal || rawVal === "-" || rawVal === "--") return;

        const code = rawVal.trim();
        const details = coursesMap[code] || {
          code: code,
          name: code,
          title: code,
          type: "Theory",
          raw_type: "Theory",
          faculty: "TBA",
          room: "TBA",
          slot: "",
          credits: ""
        };

        schedule[dayName][timeSlot] = {
          code: code,
          course: details.name,
          courseCode: code,
          courseTitle: details.name,
          name: details.name,
          slot: details.slot || "",
          type: details.type || "Theory",
          raw_type: details.raw_type || "Theory",
          room: details.room || "TBA",
          faculty: details.faculty || "TBA",
          time: timeSlot,
          credits: details.credits || ""
        };
      });
    });
  }

  return { schedule, coursesMap };
}

function parseMainMarks(html) {
  const subjects = [];
  if (!html) return subjects;
  const $ = cheerio.load(html);

  $("table tr").each((_, row) => {
    const cols = $(row).find("td");
    if (cols.length < 3) return;

    const code = $(cols[0]).text().trim();
    if (!/^[A-Z0-9]{6,12}$/.test(code)) return;

    const title = $(cols[1]).text().trim();
    const scoreStr = $(cols[2]).text().trim();

    let gotVal = null;
    let maxVal = null;
    if (scoreStr.includes("/")) {
      const parts = scoreStr.split("/");
      const g = parseFloat(parts[0].trim());
      const m = parseFloat(parts[1].trim());
      if (!isNaN(g)) gotVal = g;
      if (!isNaN(m)) maxVal = m;
    }

    let subjectId = null;
    let status = "2";
    const btn = $(row).find("button[onclick], a[onclick]");
    if (btn.length > 0) {
      const onclickText = btn.attr("onclick") || "";
      const m = onclickText.match(/funViewComponentWiseMarks\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*([0-9]+)\s*\)/);
      if (m) {
        subjectId = m[1];
        status = m[4];
      }
    }

    subjects.push({
      courseCode: code,
      title: title,
      type: "Internal",
      performance: gotVal !== null ? scoreStr : "N/A",
      assessments: [],
      totalMarkGot: gotVal,
      totalMaxMarks: maxVal,
      subjectId: subjectId,
      status: status
    });
  });

  return subjects;
}

function parseInnerMarks(innerHtml) {
  const assessments = [];
  if (!innerHtml) return assessments;
  const $ = cheerio.load(innerHtml);

  $("table tbody tr").each((_, row) => {
    const cols = $(row).find("td");
    if (cols.length >= 3) {
      const dateEntered = $(cols[0]).text().trim();
      const componentName = $(cols[1]).text().trim();
      const markStr = $(cols[2]).text().trim();

      let gotVal = "0";
      let maxVal = "0";
      if (markStr.includes("/")) {
        const parts = markStr.split("/");
        gotVal = parts[0].trim();
        maxVal = parts[1].trim();
      }

      assessments.push({
        title: componentName,
        marks: gotVal,
        total: maxVal,
        date: dateEntered
      });
    }
  });

  return assessments;
}

async function checkAcademiaExists(email) {
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
      "Origin": "https://academia.srmist.edu.in",
      "Referer": "https://academia.srmist.edu.in/"
    };
    const initRes = await axios.get(
      "https://academia.srmist.edu.in/accounts/p/10002227248/signin?hide_fp=true&orgtype=40&service_language=en&css_url=/49910842/academia-academic-services/downloadPortalCustomCss/login&dcc=true",
      { headers, timeout: 5000 }
    );
    const setCookie = initRes.headers["set-cookie"] || [];
    let csrf = "";
    const cookiesArr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookieStr of cookiesArr) {
      if (cookieStr.includes("iamcsr=")) {
        const match = cookieStr.match(/iamcsr=([^;]+)/);
        if (match) csrf = match[1];
      }
    }
    if (!csrf) return false;

    const lookupUrl = `https://academia.srmist.edu.in/accounts/p/40-10002227248/signin/v2/lookup/${email}`;
    const lookupRes = await axios.post(
      lookupUrl,
      {},
      {
        headers: {
          ...headers,
          "Cookie": `iamcsr=${csrf}`,
          "X-ZCSRF-TOKEN": `iamcsrcoo=${csrf}`
        },
        timeout: 5000
      }
    );
    const data = lookupRes.data;
    if (data && data.status_code === 400) {
      if (data.errors && Array.isArray(data.errors)) {
        for (const err of data.errors) {
          if (["U401", "U410"].includes(err.code) || (err.message && err.message.toLowerCase().includes("does not exist"))) {
            return false;
          }
        }
      }
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Health check endpoints
const healthHandler = (req, res) => {
  res.status(200).json({ status: "healthy" });
};

app.get("/", (req, res) => {
  res.status(200).json({
    status: "healthy",
    service: "Corespace Unified API",
    endpoints: {
      captcha: "/api/captcha",
      fetch: "/api/fetch",
      health: "/health"
    }
  });
});

app.head("/", healthHandler);
app.get("/health", healthHandler);
app.head("/health", healthHandler);
app.get("/healthz", healthHandler);
app.head("/healthz", healthHandler);
app.get("/api/health", healthHandler);
app.head("/api/health", healthHandler);
app.get("/ping", healthHandler);
app.head("/ping", healthHandler);

// GET /api/captcha endpoint
app.get("/api/captcha", async (req, res) => {
  cleanExpiredSessions();
  const jar = new CookieJar();

  try {
    const pageRes = await axios.get(PORTAL_LOGIN_URL, {
      headers: DEFAULT_HEADERS,
      timeout: 15000
    });
    jar.updateFromHeaders(pageRes.headers);

    const text = pageRes.data || "";
    let nonce = null;
    let m = text.match(/window\.SECURE_CONFIG\s*=\s*\{[^}]*?nonce\s*:\s*'([^']+)'/);
    if (m) nonce = m[1];
    if (!nonce) {
      m = text.match(/window\.SECURE_CONFIG\s*=\s*window\.SECURE_CONFIG\s*\|\|\s*\{\};\s*window\.SECURE_CONFIG\.nonce\s*=\s*'([^']+)'/);
      if (m) nonce = m[1];
    }
    if (!nonce) {
      m = text.match(/id="fpNonce"\s*value="([^"]+)"/);
      if (m) nonce = m[1];
    }

    const df = text.match(/domainFieldName\s*=\s*['"]([^'"]+)['"]/);
    const cf = text.match(/captchaFieldName\s*=\s*['"]([^'"]+)['"]/);
    const domainFieldName = df ? df[1] : "dtoken_x";
    const captchaFieldName = cf ? cf[1] : "cptoken_x";

    const exposedMatch = text.match(/"captchaText"\s*:\s*"([^"]+)"/) || text.match(/captchaText\s*=\s*'([^']+)'/);
    const exposedCaptchaText = exposedMatch ? exposedMatch[1] : "";

    const delimMatch = text.match(/randomDelimiter\s*=\s*'([^']+)'/);
    const randomDelimiter = delimMatch ? delimMatch[1] : "0000";

    const loginFormFields = {};
    const inputMatches = text.matchAll(/<input[^>]*name=['"]([^'"]+)['"][^>]*>/gi);
    for (const match of inputMatches) {
      loginFormFields[match[1]] = "";
    }

    const captchaMatch = text.match(/SCaptchaServlet[^'" ]*/);
    let captchaUrl = null;
    if (captchaMatch) {
      const seg = captchaMatch[0];
      captchaUrl = seg.startsWith("/") ? `https://sp.srmist.edu.in${seg}` : `${PORTAL_BASE_URL}/${seg}`;
    }

    let imgB64 = null;
    if (captchaUrl) {
      const proof = Buffer.from(`${nonce}:sp.srmist.edu.in`).toString("base64");
      const imgRes = await axios.get(captchaUrl, {
        headers: {
          ...DEFAULT_HEADERS,
          "Cookie": jar.toHeaderString(),
          "X-Domain-Proof": proof,
          "Accept": "image/png, image/jpeg, image/svg+xml, image/*"
        },
        responseType: "arraybuffer",
        timeout: 15000
      });
      jar.updateFromHeaders(imgRes.headers);
      if (imgRes.status === 200) {
        imgB64 = Buffer.from(imgRes.data).toString("base64");
      }
    }

    const sessionId = crypto.randomUUID();
    const cookiesDict = jar.toDict();

    const sessState = {
      timestamp: Date.now(),
      nonce,
      domain_field_name: domainFieldName,
      captcha_field_name: captchaFieldName,
      random_delimiter: randomDelimiter,
      login_form_fields: loginFormFields,
      load_ms: Date.now(),
      cookies: cookiesDict
    };

    SESSION_STORE.set(sessionId, sessState);
    if (cookiesDict["JSESSIONID"]) {
      SESSION_STORE.set(cookiesDict["JSESSIONID"], sessState);
    }

    return res.status(200).json({
      success: true,
      session_id: sessionId,
      captcha_image: imgB64 ? `data:image/png;base64,${imgB64}` : null,
      cookies: cookiesDict
    });
  } catch (err) {
    console.error("Captcha error:", err.message);
    return res.status(502).json({
      detail: `Failed to load captcha from Portal: ${err.message}`
    });
  }
});

// POST /api/fetch endpoint
app.post("/api/fetch", async (req, res) => {
  cleanExpiredSessions();
  const {
    portal_netid,
    portal_password,
    portal_captcha,
    session_id,
    portal_cookies,
    academia_password
  } = req.body || {};

  if (!portal_netid || !portal_password || !portal_captcha) {
    return res.status(400).json({
      detail: "portal_netid, portal_password, and portal_captcha are required."
    });
  }

  // Retrieve existing captcha session state
  let sessData = null;
  if (session_id && SESSION_STORE.has(session_id)) {
    sessData = SESSION_STORE.get(session_id);
    SESSION_STORE.delete(session_id);
  } else if (portal_cookies && portal_cookies["JSESSIONID"] && SESSION_STORE.has(portal_cookies["JSESSIONID"])) {
    sessData = SESSION_STORE.get(portal_cookies["JSESSIONID"]);
    SESSION_STORE.delete(portal_cookies["JSESSIONID"]);
  }

  const jar = new CookieJar(sessData ? sessData.cookies : (portal_cookies || {}));
  const nonce = sessData ? sessData.nonce : null;
  const domainFieldName = sessData ? sessData.domain_field_name : "dtoken_x";
  const captchaFieldName = sessData ? sessData.captcha_field_name : "cptoken_x";
  const randomDelimiter = sessData ? sessData.random_delimiter : "0000";
  const loginFormFields = sessData ? sessData.login_form_fields : {};
  const loadMs = sessData ? sessData.load_ms : Date.now();

  const nowMs = Date.now();
  const calcElapsed = Math.max(0, Math.floor((nowMs - loadMs) / 1000));
  const elapsedSec = Math.max(Math.floor(Math.random() * 3) + 3, calcElapsed);

  const dtoken = Buffer.from("sp.srmist.edu.in".split("").reverse().join("")).toString("base64");
  const trapPayload = `${elapsedSec}${randomDelimiter}3`;
  const cptoken = Buffer.from(trapPayload).toString("base64");
  const fpPayload = Buffer.from(JSON.stringify({ fp: "", nonce: nonce, ts: nowMs })).toString("base64");
  const telemetryB64 = generateTelemetryPayload();

  const formData = new URLSearchParams();
  for (const [k, v] of Object.entries(loginFormFields)) {
    formData.append(k, v || "");
  }
  formData.set("username", portal_netid);
  formData.set("password", portal_password);
  formData.set("captcha", portal_captcha);
  formData.set("fpPayload", fpPayload);
  formData.set("fpToken", "");
  formData.set("recaptchaToken", "");
  formData.set("telemetryPayload", telemetryB64);
  formData.set(domainFieldName, dtoken);
  formData.set(captchaFieldName, cptoken);

  let loginResp = null;
  try {
    loginResp = await axios.post(PORTAL_LOGIN_SERVLET, formData.toString(), {
      headers: {
        ...DEFAULT_HEADERS,
        "Content-Type": "application/x-www-form-urlencoded",
        "Cookie": jar.toHeaderString()
      },
      maxRedirects: 5,
      timeout: 20000
    });
    jar.updateFromHeaders(loginResp.headers);
  } catch (err) {
    console.error("Portal login HTTP error:", err.message);
    return res.status(500).json({ detail: `Portal login request error: ${err.message}` });
  }

  const body = loginResp.data || "";
  let attHtml = null;

  // Verify whether login succeeded or returned an authentication failure
  const isDirectSuccess = typeof body === "string" && (
    body.includes("logout.jsp") ||
    body.toLowerCase().includes("attendance") ||
    body.toLowerCase().includes("hrdsystem")
  );

  if (isDirectSuccess) {
    attHtml = body;
  } else {
    try {
      const attRes = await axios.get(PORTAL_ATT_URL, {
        headers: {
          ...DEFAULT_HEADERS,
          "Cookie": jar.toHeaderString()
        },
        timeout: 15000
      });
      jar.updateFromHeaders(attRes.headers);
      const attBody = attRes.data || "";
      if (
        attRes.status === 200 &&
        !attBody.toLowerCase().includes("youlogin") &&
        !attBody.toLowerCase().includes("loginform") &&
        !attBody.toLowerCase().includes("thegr8loginloader")
      ) {
        attHtml = attBody;
      }
    } catch (e) {
      // Ignored
    }
  }

  if (!attHtml) {
    const failureInfo = classifyFailure(body);
    return res.status(401).json({
      detail: {
        message: failureInfo.message,
        reason: failureInfo.reason
      }
    });
  }

  // Fetch Portal Marks, Timetable, Profile concurrently
  const fetchMarks = async () => {
    try {
      const mRes = await axios.get(PORTAL_MARKS_URL, {
        headers: { ...DEFAULT_HEADERS, "Cookie": jar.toHeaderString() },
        timeout: 15000
      });
      jar.updateFromHeaders(mRes.headers);
      if (mRes.status === 200 && typeof mRes.data === "string" && mRes.data.toLowerCase().includes("table")) {
        const subjects = parseMainMarks(mRes.data);
        await Promise.all(
          subjects.map(async (subj) => {
            if (!subj.subjectId) return;
            const payload = new URLSearchParams({
              iden: "1",
              hdnSubjectId: subj.subjectId,
              status: subj.status || "2"
            });
            try {
              const innerRes = await axios.post(PORTAL_INNER_MARKS_URL, payload.toString(), {
                headers: {
                  ...DEFAULT_HEADERS,
                  "Content-Type": "application/x-www-form-urlencoded",
                  "Cookie": jar.toHeaderString()
                },
                timeout: 10000
              });
              if (innerRes.status === 200) {
                subj.assessments = parseInnerMarks(innerRes.data);
              }
            } catch (e) {
              // Ignore inner mark failure per subject
            }
          })
        );
        for (const s of subjects) {
          delete s.subjectId;
          delete s.status;
        }
        return subjects;
      }
    } catch (e) {
      console.error("Marks fetch error:", e.message);
    }
    return [];
  };

  const fetchTimetable = async () => {
    try {
      const payload = new URLSearchParams({
        iden: "10",
        filter: "",
        hdnFormDetails: "1",
        csrfPreventionSalt: ""
      });
      const ttRes = await axios.post(PORTAL_TIMETABLE_URL, payload.toString(), {
        headers: {
          ...DEFAULT_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": jar.toHeaderString()
        },
        timeout: 15000
      });
      if (ttRes.status === 200) {
        return ttRes.data;
      }
    } catch (e) {
      console.error("Timetable fetch error:", e.message);
    }
    return null;
  };

  const fetchProfile = async () => {
    try {
      const pRes = await axios.post(PORTAL_PROFILE_URL, "", {
        headers: {
          ...DEFAULT_HEADERS,
          "Cookie": jar.toHeaderString()
        },
        timeout: 15000
      });
      if (pRes.status === 200 && typeof pRes.data === "string" && pRes.data.toLowerCase().includes("student name")) {
        return pRes.data;
      }
    } catch (e) {
      console.error("Profile fetch error:", e.message);
    }
    return null;
  };

  const email = portal_netid.includes("@") ? portal_netid : `${portal_netid}@srmist.edu.in`;
  const acadCheckPromise = checkAcademiaExists(email);

  const [marksData, ttHtml, profHtml, isAcadAvailable] = await Promise.all([
    fetchMarks(),
    fetchTimetable(),
    fetchProfile(),
    acadCheckPromise
  ]);

  const { courses: attCourses } = parseAttendance(attHtml);
  const profile = parseProfile(profHtml);
  const { schedule: portalSchedule } = parseTimetable(ttHtml);

  // Load calendar_data.json
  let calendarData = [];
  try {
    const calPath = path.join(__dirname, "calendar_data.json");
    if (fs.existsSync(calPath)) {
      calendarData = JSON.parse(fs.readFileSync(calPath, "utf8"));
    }
  } catch (e) {
    console.error("Calendar read error:", e.message);
  }

  return res.status(200).json({
    success: true,
    is_academia_available: isAcadAvailable,
    profile,
    courses: {},
    attendance: attCourses,
    marks: marksData || [],
    timetable: {
      academia: {},
      portal: portalSchedule
    },
    calendar: calendarData
  });
});

const rawPort = process.env.PORT;
const port = rawPort && !isNaN(parseInt(rawPort, 10)) ? parseInt(rawPort, 10) : 8000;

app.listen(port, "0.0.0.0", () => {
  console.log(`[STARTUP] Corespace Express Server listening on 0.0.0.0:${port}`);
});
