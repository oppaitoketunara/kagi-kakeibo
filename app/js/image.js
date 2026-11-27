// かぎ家計簿 — レシート写真の取り込みと表示
//
// 取り込むときに、端末の中で縮小して JPEG に描き直す。
//   - 容量を抑える(1 枚あたり数百 KB)
//   - 撮影場所(GPS)や機種名などの付帯情報は、描き直した画像には引き継がれない
// 表示は <img> ではなく <canvas> に描く。画像の URL を作らずに済み、CSP をゆるめなくてよい。

const MAX_SIDE = 1600;
const MAX_SOURCE_BYTES = 40 * 1024 * 1024;
const MAX_RESULT_BYTES = 1_500_000;

export class ImageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ImageError';
  }
}

async function decode(blob) {
  try {
    // 撮影時の向き(縦横)を反映して読み込む
    return await createImageBitmap(blob, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(blob);
    } catch {
      throw new ImageError('この写真は読み込めませんでした。別の写真でお試しください。');
    }
  }
}

function toJpeg(canvas, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', quality);
  });
}

/** 選ばれた写真を、保存用の JPEG(バイト列)にする。 */
export async function prepareReceiptImage(file) {
  if (!(file instanceof Blob) || !file.type.startsWith('image/')) {
    throw new ImageError('写真(画像ファイル)を選んでください。');
  }
  if (file.size > MAX_SOURCE_BYTES) throw new ImageError('写真が大きすぎます。');
  const bitmap = await decode(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4]) {
      const blob = await toJpeg(canvas, quality);
      if (blob !== null && blob.size <= MAX_RESULT_BYTES) return new Uint8Array(await blob.arrayBuffer());
    }
    throw new ImageError('写真を保存できる大きさにできませんでした。');
  } finally {
    bitmap.close();
  }
}

/** 保存してある JPEG を canvas に描く。 */
export async function drawReceipt(canvas, bytes) {
  const bitmap = await decode(new Blob([bytes], { type: 'image/jpeg' }));
  try {
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}
