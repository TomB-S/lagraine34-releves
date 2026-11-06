import PDFDocument from "pdfkit";

// Builds the PDF in memory and resolves with a Buffer. Nothing is sent to the
// client before this resolves, so the caller can still answer with a normal
// error page if anything fails.
export function renderTicketPdf(model) {
  return new Promise((resolve, reject) => {
    // Only the title is set. pdfkit itself always adds Producer/Creator
    // ("PDFKit") and the creation date; it needs them, so they stay. No author.
    const doc = new PDFDocument({
      size: "A4",
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: { Title: model.title },
    });

    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      doc.font("Helvetica-Bold").fontSize(16).text(model.title);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
