import { COMPLIANCE_MINUTES } from "./constants.js";
import { compact, durationLabel, leakFromLmin, leakFromLps, leakUnitLabel, maskWindowSummary } from "./format.js";

export function downloadText(fileName, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking synchronously can cancel the download in Safari and Firefox.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("; ") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n");
}

export function sanitizeReportText(value) {
  return String(value ?? "")
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function pdfEscape(value) {
  return sanitizeReportText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

export function wrapReportLine(text, maxChars = 88) {
  const clean = sanitizeReportText(text);
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines = [];
  let line = "";
  words.forEach((word) => {
    if (!line) {
      line = word;
      return;
    }
    if (`${line} ${word}`.length > maxChars) {
      lines.push(line);
      line = word;
      return;
    }
    line = `${line} ${word}`;
  });
  if (line) lines.push(line);
  return lines;
}

export function flattenPdfSections(title, sections) {
  const lines = [title, `Generated ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, ""];
  sections.forEach((section) => {
    lines.push(section.title.toUpperCase());
    (section.lines || []).forEach((line) => {
      wrapReportLine(line).forEach((wrapped) => lines.push(wrapped));
    });
    lines.push("");
  });
  return lines;
}

export function downloadPdfFromSections(fileName, title, sections) {
  const rawLines = flattenPdfSections(title, sections);
  const linesPerPage = 48;
  const pages = [];
  for (let i = 0; i < rawLines.length; i += linesPerPage) {
    pages.push(rawLines.slice(i, i + linesPerPage));
  }

  const objects = new Map();
  const kids = [];
  const fontObjectId = 3;
  let nextObjectId = 4;

  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(fontObjectId, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  pages.forEach((pageLines) => {
    const pageObjectId = nextObjectId;
    const contentObjectId = nextObjectId + 1;
    nextObjectId += 2;
    kids.push(`${pageObjectId} 0 R`);
    const content = [
      "BT",
      "/F1 11 Tf",
      "14 TL",
      "40 752 Td",
      ...pageLines.map((line) => `(${pdfEscape(line)}) Tj T*`),
      "ET",
    ].join("\n");
    objects.set(
      pageObjectId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >>`
    );
    objects.set(contentObjectId, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });

  objects.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`);

  const maxObjectId = nextObjectId - 1;
  let pdf = "%PDF-1.4\n";
  const offsets = Array(maxObjectId + 1).fill(0);
  for (let id = 1; id <= maxObjectId; id += 1) {
    offsets[id] = pdf.length;
    pdf += `${id} 0 obj\n${objects.get(id)}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${maxObjectId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maxObjectId; id += 1) {
    pdf += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxObjectId + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  downloadText(fileName, pdf, "application/pdf");
}

export function reportDateSlug(value) {
  return (value || "report").replace(/[^0-9A-Za-z-]+/g, "-");
}

export function complianceRowsForExport(compliance, prefs) {
  return compliance.rows.map((row) => ({
    date: row.date,
    usage: Number.isFinite(row.usageMinutes) ? durationLabel(row.usageMinutes * 60) : "--",
    compliant: Number.isFinite(row.usageMinutes) && row.usageMinutes >= COMPLIANCE_MINUTES ? "yes" : "no",
    ahi: compact(row.ahi, 2),
    leak_95: `${compact(leakFromLmin(row.leak95LMin, prefs), 1)} ${leakUnitLabel(prefs)}`,
    pressure_95: `${compact(row.pressure95, 1)} cmH2O`,
    mask_windows: maskWindowSummary(row.maskWindows),
  }));
}

export function clusterRowsForExport(clusters, prefs) {
  return clusters.map((cluster) => ({
    cluster: cluster.id,
    start: cluster.startLabel,
    end: cluster.endLabel,
    duration: durationLabel(cluster.duration),
    events: cluster.count,
    rate_per_hr: compact(cluster.rate, 1),
    event_mix: cluster.typeSummary,
    avg_pressure: `${compact(cluster.avgPressure, 1)} cmH2O`,
    avg_leak: `${compact(leakFromLps(cluster.avgLeak, prefs), 1)} ${leakUnitLabel(prefs)}`,
  }));
}

export function buildCompliancePdfSections(compliance, prefs) {
  return [
    {
      title: "30-Night Compliance",
      lines: [
        `Date range: ${compliance.startDate || "--"} to ${compliance.endDate || "--"}`,
        `Nights with usage: ${compliance.nightsWithUsage}/${compliance.nights}`,
        `Nights >= 4 hours: ${compliance.compliantNights}/${compliance.nightsWithUsage}`,
        `Compliance: ${compact(compliance.percent, 1)}%`,
        `Average usage: ${compact(compliance.avgUsageHours, 2)} hr/night`,
        `Average AHI: ${compact(compliance.avgAhi, 2)}/hr`,
        `Average leak 95%: ${compact(leakFromLmin(compliance.avgLeak95LMin, prefs), 1)} ${leakUnitLabel(prefs)}`,
        `Average pressure 95%: ${compact(compliance.avgPressure95, 1)} cmH2O`,
      ],
    },
    {
      title: "Daily Rows",
      lines: complianceRowsForExport(compliance, prefs).map(
        (row) => `${row.date}: usage ${row.usage}, compliant ${row.compliant}, AHI ${row.ahi}, leak ${row.leak_95}, pressure ${row.pressure_95}`
      ),
    },
  ];
}

export function buildDoctorReportSections({ session, summary, compliance, prefs, selectedSections }) {
  const sections = [
    {
      title: "Sleep Summary",
      lines: [
        summary.headline,
        ...summary.positives.map((item) => `OK: ${item}`),
        ...(summary.review.length ? summary.review.map((item) => `Review: ${item}`) : ["Review: no major review flags from the rule-based checks."]),
        ...summary.signalWarnings.map((item) => `Signal note: ${item}`),
      ],
    },
    {
      title: "Key Metrics",
      lines: [
        `Date: ${session.date || "unknown"}`,
        `Therapy time: ${durationLabel(summary.metrics.therapySeconds)}`,
        `AHI: ${compact(summary.metrics.ahi, 2)}/hr`,
        `Pressure 95%: ${compact(summary.metrics.pressure95, 1)} cmH2O`,
        `Pressure median: ${compact(summary.metrics.pressureMedian, 1)} cmH2O`,
        `Leak 95%: ${compact(summary.metrics.leakDisplay, 1)} ${leakUnitLabel(prefs)}`,
        `Events: central ${session.eventCounts.central}, obstructive ${session.eventCounts.obstructive}, hypopnea ${session.eventCounts.hypopnea}`,
      ],
    },
  ];

  if (selectedSections.events) {
    sections.push({
      title: "Event Breakdown",
      lines: [
        `Total annotations: ${session.eventCounts.all}`,
        `Central apnea: ${session.eventCounts.central}`,
        `Obstructive apnea: ${session.eventCounts.obstructive}`,
        `Hypopnea: ${session.eventCounts.hypopnea}`,
      ],
    });
  }

  if (selectedSections.clusters) {
    sections.push({
      title: "Event Clusters",
      lines: session.eventClusters?.length
        ? clusterRowsForExport(session.eventClusters, prefs).map(
            (row) => `Cluster ${row.cluster}: ${row.start}-${row.end}, ${row.events} events, ${row.rate_per_hr}/hr, ${row.event_mix}`
          )
        : ["No event clusters found using the current spacing rule."],
    });
  }

  if (selectedSections.timeline) {
    sections.push({
      title: "Therapy Timeline Chart Notes",
      lines: [
        `Pressure samples: ${session.series.pressure.length.toLocaleString()}`,
        `Leak samples: ${session.series.leak.length.toLocaleString()}`,
        `Respiration samples: ${session.series.respiration.length.toLocaleString()}`,
        `Gaps detected: ${session.gaps.length}`,
      ],
    });
  }

  if (selectedSections.flow) {
    sections.push({
      title: "Breath Flow Chart Notes",
      lines: [
        `Flow samples shown: ${session.series.flow.length.toLocaleString()}`,
        `Flow range: ${compact(session.stats.flowMinMax.min, 2)} to ${compact(session.stats.flowMinMax.max, 2)} L/s`,
      ],
    });
  }

  if (selectedSections.oximetry) {
    sections.push({
      title: "Oximetry Chart Notes",
      lines: [
        `SpO2 median: ${compact(session.stats.spo2Median, 1)}%`,
        `SpO2 low percentile: ${compact(session.stats.spo2Low, 1)}%`,
        `Pulse median: ${compact(session.stats.pulseMedian, 1)} bpm`,
      ],
    });
  }

  if (selectedSections.compliance && compliance.rows.length) {
    sections.push(...buildCompliancePdfSections(compliance, prefs));
  }

  return sections;
}

export function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function openPrintableReport(title, sections) {
  const body = sections.map((section) => `
    <section>
      <h2>${htmlEscape(section.title)}</h2>
      ${(section.lines || []).map((line) => `<p>${htmlEscape(line)}</p>`).join("")}
    </section>
  `).join("");
  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${htmlEscape(title)}</title>
        <style>
          body { font: 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 34px; color: #111827; }
          h1 { font-size: 22px; margin: 0 0 16px; }
          h2 { font-size: 14px; margin: 22px 0 8px; border-bottom: 1px solid #d1d5db; padding-bottom: 4px; }
          p { margin: 4px 0; line-height: 1.35; }
          @media print { button { display: none; } }
        </style>
      </head>
      <body>
        <button onclick="window.print()">Print / Save PDF</button>
        <h1>${htmlEscape(title)}</h1>
        ${body}
      </body>
    </html>`;
  const win = window.open("", "_blank");
  if (!win) {
    downloadText(`${reportDateSlug(title)}.html`, html, "text/html");
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
}
