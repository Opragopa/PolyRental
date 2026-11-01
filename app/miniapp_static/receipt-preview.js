// PDF bytes stay in this authorised browser session; no external viewer/upload.
export function renderReceiptPdf(host, bytes) {
  let closed = false, task = null, renderTask = null;
  const status = host.querySelector('.receipt-preview-status');
  const pages = host.querySelector('.receipt-pages');
  const ready = (async () => {
    const pdfjs = await import('./pdf.min.mjs');
    if (closed) return;
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href;
    task = pdfjs.getDocument({data: bytes, isEvalSupported: false, useSystemFonts: true,
      wasmUrl: new URL('./pdfjs-assets/wasm/', import.meta.url).href,
      standardFontDataUrl: new URL('./pdfjs-assets/standard_fonts/', import.meta.url).href});
    const pdf = await task.promise;
    for (let number = 1; number <= pdf.numPages; number++) {
      if (closed) return;
      status.textContent = `Загрузка страницы ${number} из ${pdf.numPages}…`;
      const page = await pdf.getPage(number);
      if (closed) return;
      const original = page.getViewport({scale: 1});
      const width = Math.min(1000, Math.max(240, pages.clientWidth || 340));
      const viewport = page.getViewport({scale: width / original.width});
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const figure = document.createElement('figure');
      const caption = document.createElement('figcaption'); caption.textContent = `Страница ${number} из ${pdf.numPages}`;
      const canvas = document.createElement('canvas');
      canvas.setAttribute('aria-label', caption.textContent);
      canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
      figure.append(caption, canvas); pages.append(figure);
      renderTask = page.render({canvasContext: canvas.getContext('2d'), viewport,
        transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0]});
      await renderTask.promise;
      renderTask = null; page.cleanup();
    }
    if (!closed) {status.textContent = `Страниц: ${pdf.numPages}`; host.dataset.previewReady = 'true';}
  })().catch(() => {
    if (!closed) { status.textContent = 'Не удалось показать страницы. Скачайте сохранённый PDF, чтобы открыть его на устройстве.'; status.setAttribute('role', 'alert'); }
  });
  return {ready, close() {
    closed = true; renderTask?.cancel();
    void task?.destroy().catch(() => {});
    for (const canvas of pages.querySelectorAll('canvas')) {canvas.width = 0; canvas.height = 0;}
    pages.replaceChildren();
  }};
}
