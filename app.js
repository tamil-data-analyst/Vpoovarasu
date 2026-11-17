// ---------- Elements ----------
const dropzone = document.getElementById("dropzone");
const resumeInput = document.getElementById("resume-input");
const fileNameEl = document.getElementById("file-name");
const fileErrorEl = document.getElementById("file-error");
const jdInput = document.getElementById("jd-input");
const analyzeBtn = document.getElementById("analyze-btn");
const formErrorEl = document.getElementById("form-error");
const scorecard = document.getElementById("scorecard");

// The resume text is kept here once the file has been read.
let resumeText = "";

// Tell pdf.js where its worker script is (it parses PDFs in a background thread).
if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
}

// ---------- Drag and drop ----------
// Browsers open a dropped file in a new tab unless we stop the default action.
["dragenter", "dragover"].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add("border-indigo-400", "bg-slate-800/50");
  });
});

["dragleave", "drop"].forEach((type) => {
  dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove("border-indigo-400", "bg-slate-800/50");
  });
});

dropzone.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (file) handleFile(file);
});

// Clicking the zone opens the file picker, via the hidden <input>.
resumeInput.addEventListener("change", () => {
  if (resumeInput.files[0]) handleFile(resumeInput.files[0]);
});

// ---------- Reading the file ----------
const MAX_BYTES = 5 * 1024 * 1024;

async function handleFile(file) {
  fileErrorEl.textContent = "";
  resumeText = "";
  fileNameEl.textContent = `Reading ${file.name}...`;

  const isPdf = file.name.toLowerCase().endsWith(".pdf");
  const isDocx = file.name.toLowerCase().endsWith(".docx");

  if (!isPdf && !isDocx) {
    fileNameEl.textContent = "";
    fileErrorEl.textContent = "That file type is not supported. Please upload a PDF or .docx file.";
    return;
  }
  if (file.size > MAX_BYTES) {
    fileNameEl.textContent = "";
    fileErrorEl.textContent = "That file is larger than 5 MB.";
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    resumeText = isPdf ? await readPdf(buffer) : await readDocx(buffer);

    if (resumeText.trim().length === 0) {
      throw new Error("No text found. If your PDF is a scanned image, use a text-based PDF.");
    }
    fileNameEl.textContent = `Loaded: ${file.name}`;
  } catch (error) {
    fileNameEl.textContent = "";
    fileErrorEl.textContent = `Could not read that file. ${error.message}`;
  }
}

async function readPdf(buffer) {
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  let text = "";
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    // Each item is a piece of text. Join them with spaces, and add a line break per page.
    text += content.items.map((item) => item.str).join(" ") + "\n";
  }
  return text;
}

async function readDocx(buffer) {
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

// ---------- Text analysis ----------
// Common English words that carry no meaning for a job match.
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "in",
  "is", "it", "its", "of", "on", "or", "that", "the", "their", "they", "this", "to",
  "was", "we", "will", "with", "you", "your", "our", "who", "what", "which", "can",
  "about", "all", "also", "any", "been", "but", "etc", "not", "other", "such", "than",
  "into", "more", "most", "new", "use", "using", "work", "working", "team", "role",
  "including", "experience", "years", "year", "strong", "good", "ability", "skills",
  "must", "should", "would", "may", "etc", "like", "way", "well", "make", "help",
]);

// Lowercase words, keeping characters used in tech names: c++, c#, node.js, ci/cd -> ci, cd.
function tokenize(text) {
  const matches = text.toLowerCase().match(/[a-z][a-z0-9+#.]*[a-z0-9+#]|[a-z]{2,}/g) || [];
  return matches
    .map((word) => word.replace(/\.+$/, ""))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
}

// Count how often each term appears in the job description, then keep the most frequent.
function extractKeywords(jobText, limit = 30) {
  const counts = new Map();
  for (const word of tokenize(jobText)) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

// Checks about the structure of the resume, not the job.
function structureChecks(text) {
  const quantified = text.match(/\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*|\b\d{2,}\+?\b/g) || [];
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return [
    { label: "Work experience section", pass: /experience|employment|work history/i.test(text) },
    { label: "Education section", pass: /education|degree|university|college/i.test(text) },
    { label: "Skills section", pass: /skills?|technologies|tools/i.test(text) },
    { label: "Projects section", pass: /projects?/i.test(text) },
    { label: "Email address", pass: /[\w.+-]+@[\w-]+\.[\w.]+/.test(text) },
    { label: "At least 3 numbers or metrics", pass: quantified.length >= 3, detail: `${quantified.length} found` },
    { label: "Length between 300 and 900 words", pass: wordCount >= 300 && wordCount <= 900, detail: `${wordCount} words` },
  ];
}

// ---------- Scoring ----------
// Keyword match is weighted by how often each term appears in the job description.
function scoreResume(resume, jobText) {
  const resumeWords = new Set(tokenize(resume));
  const keywords = extractKeywords(jobText);

  const totalWeight = keywords.reduce((sum, k) => sum + k.count, 0);
  const matched = keywords.filter((k) => resumeWords.has(k.term));
  const missing = keywords.filter((k) => !resumeWords.has(k.term));
  const matchedWeight = matched.reduce((sum, k) => sum + k.count, 0);

  const keywordScore = totalWeight ? Math.round((matchedWeight / totalWeight) * 100) : 0;

  const checks = structureChecks(resume);
  const structureScore = Math.round((checks.filter((c) => c.pass).length / checks.length) * 100);

  // Keywords count for 70% of the overall score, and structure for 30%.
  const overall = Math.round(keywordScore * 0.7 + structureScore * 0.3);

  return { overall, keywordScore, structureScore, matched, missing, checks };
}

// ---------- Scorecard output ----------
function makeChip(text, colourClasses) {
  const chip = document.createElement("span");
  chip.className = `rounded-full px-3 py-1 text-sm ${colourClasses}`;
  chip.textContent = text;
  return chip;
}

function fillList(listEl, items) {
  listEl.replaceChildren(...items.map((text) => {
    const li = document.createElement("li");
    li.textContent = text;
    return li;
  }));
}

function buildStrengths(result) {
  const strengths = [];
  const topMatched = result.matched.slice(0, 5).map((k) => k.term);
  if (topMatched.length) {
    strengths.push(`Covers key terms from the job: ${topMatched.join(", ")}.`);
  }
  if (result.keywordScore >= 70) {
    strengths.push("Strong keyword overlap with the job description.");
  }
  const passedChecks = result.checks.filter((c) => c.pass).map((c) => c.label.toLowerCase());
  if (passedChecks.length) {
    strengths.push(`Good structure: ${passedChecks.slice(0, 3).join(", ")}.`);
  }
  if (!strengths.length) strengths.push("No clear strengths found. Add more of the job's own terms.");
  return strengths;
}

function buildWeaknesses(result) {
  const weaknesses = [];
  const topMissing = result.missing.slice(0, 5).map((k) => k.term);
  if (topMissing.length) {
    weaknesses.push(`Missing terms that appear often in the job: ${topMissing.join(", ")}.`);
  }
  const failed = result.checks.filter((c) => !c.pass);
  for (const check of failed) {
    weaknesses.push(`Fix: ${check.label.toLowerCase()}${check.detail ? ` (${check.detail})` : ""}.`);
  }
  if (!weaknesses.length) weaknesses.push("No major weaknesses found.");
  return weaknesses;
}

function renderResult(result) {
  // Score ring: the dashoffset hides part of the circle. 0 offset = full ring.
  const circumference = 339.29;
  document.getElementById("score-ring").style.strokeDashoffset =
    circumference * (1 - result.overall / 100);
  document.getElementById("score-value").textContent = `${result.overall}`;

  const label =
    result.overall >= 75 ? "Strong match" : result.overall >= 50 ? "Partial match" : "Weak match";
  document.getElementById("score-label").textContent = label;

  document.getElementById("kw-score").textContent = `${result.keywordScore}%`;
  document.getElementById("structure-score").textContent = `${result.structureScore}%`;

  const matchedList = document.getElementById("matched-list");
  matchedList.replaceChildren(
    ...result.matched.map((k) => makeChip(k.term, "bg-emerald-500/15 text-emerald-300"))
  );
  if (!result.matched.length) matchedList.textContent = "None of the job's keywords were found.";

  const missingList = document.getElementById("missing-list");
  missingList.replaceChildren(
    ...result.missing.map((k) => makeChip(k.term, "bg-rose-500/15 text-rose-300"))
  );
  if (!result.missing.length) missingList.textContent = "Nothing missing. Well done.";

  fillList(document.getElementById("strengths-list"), buildStrengths(result));
  fillList(document.getElementById("weaknesses-list"), buildWeaknesses(result));

  const checksList = document.getElementById("checks-list");
  checksList.replaceChildren(...result.checks.map((check) => {
    const li = document.createElement("li");
    li.className = "flex items-center gap-2";
    const mark = document.createElement("span");
    mark.textContent = check.pass ? "✓" : "✗";
    mark.className = check.pass ? "text-emerald-400" : "text-rose-400";
    const text = document.createElement("span");
    text.textContent = check.detail ? `${check.label} (${check.detail})` : check.label;
    li.append(mark, text);
    return li;
  }));

  scorecard.classList.remove("hidden");
  scorecard.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---------- Button ----------
analyzeBtn.addEventListener("click", () => {
  formErrorEl.textContent = "";

  if (!resumeText) {
    formErrorEl.textContent = "Upload your resume first.";
    return;
  }
  if (jdInput.value.trim().split(/\s+/).length < 20) {
    formErrorEl.textContent = "Paste a fuller job description (at least about 20 words).";
    return;
  }

  renderResult(scoreResume(resumeText, jdInput.value));
});
