import { getStore } from "@netlify/blobs";

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }
});

const clean = (value, max) => String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
const allowedPhotoTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
const maxPhotoSize = 3 * 1024 * 1024;

async function hash(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export default async (req, context) => {
  const store = getStore({ name: "b3dprint-reviews", consistency: "strong" });
  const url = new URL(req.url);

  if (req.method === "GET") {
    const photoId = url.searchParams.get("photo");

    if (photoId) {
      if (!/^[0-9]+-[0-9a-f-]{36}$/i.test(photoId)) {
        return new Response("Фото не найдено", { status: 404 });
      }

      const entry = await store.getWithMetadata(`photo/${photoId}`, {
        type: "arrayBuffer",
        consistency: "strong"
      }).catch(() => null);

      if (!entry?.data) return new Response("Фото не найдено", { status: 404 });

      return new Response(entry.data, {
        status: 200,
        headers: {
          "content-type": entry.metadata?.contentType || "image/jpeg",
          "cache-control": "public, max-age=86400",
          "x-content-type-options": "nosniff"
        }
      });
    }

    const { blobs } = await store.list({ prefix: "review/" });
    const recent = blobs.sort((a,b) => b.key.localeCompare(a.key)).slice(0, 50);
    const reviews = (await Promise.all(recent.map(async ({ key }) => {
      try { return await store.get(key, { type: "json", consistency: "strong" }); }
      catch { return null; }
    }))).filter(Boolean).map(({ name, product, rating, text, createdAt, id, photoUrl }) => ({
      name, product, rating, text, createdAt, id, photoUrl
    }));

    return json({ reviews });
  }

  if (req.method !== "POST") return json({ error: "Метод не поддерживается" }, 405);

  let body = {};
  let photo = null;
  const contentType = req.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      body = {
        name: form.get("name"),
        product: form.get("product"),
        rating: form.get("rating"),
        text: form.get("text"),
        website: form.get("website")
      };
      const candidate = form.get("photo");
      if (candidate instanceof File && candidate.size > 0) photo = candidate;
    } else {
      body = await req.json();
    }
  } catch {
    return json({ error: "Неверные данные формы" }, 400);
  }

  // Невидимое поле для простых спам-ботов.
  if (body.website) return json({ ok: true });

  const name = clean(body.name, 40);
  const product = clean(body.product, 80);
  const text = clean(body.text, 1000);
  const rating = Number(body.rating);

  if (name.length < 2) return json({ error: "Укажите имя" }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return json({ error: "Поставьте оценку от 1 до 5" }, 400);
  }

  // Текст отзыва НЕ обязателен.
  if (/(https?:\/\/|www\.)/i.test(text) || /(https?:\/\/|www\.)/i.test(product)) {
    return json({ error: "Ссылки в отзывах не поддерживаются" }, 400);
  }

  // Фото тоже НЕ обязательно.
  if (photo) {
    if (!allowedPhotoTypes.has(photo.type)) {
      return json({ error: "Фото должно быть JPG, PNG или WebP" }, 400);
    }
    if (photo.size > maxPhotoSize) {
      return json({ error: "Фото слишком большое. Максимум 3 МБ" }, 400);
    }
  }

  // IP не сохраняем. Хеш используется только для ограничения частых отправок.
  const ipHash = await hash(`${context.ip || "unknown"}|b3dprint-review-rate-v1`);
  const rateKey = `rate/${ipHash}`;
  const last = await store.get(rateKey, { type: "json", consistency: "strong" }).catch(() => null);
  const now = Date.now();

  if (last?.time && now - last.time < 10 * 60 * 1000) {
    return json({ error: "С этого устройства отзыв уже отправлялся недавно. Попробуйте чуть позже." }, 429);
  }

  const id = `${now}-${crypto.randomUUID()}`;
  let photoUrl = "";

  if (photo) {
    await store.set(`photo/${id}`, photo, {
      metadata: { contentType: photo.type }
    });
    photoUrl = `/api/reviews?photo=${encodeURIComponent(id)}`;
  }

  const review = {
    id,
    name,
    product,
    rating,
    text,
    photoUrl,
    createdAt: new Date(now).toISOString()
  };

  await store.setJSON(`review/${id}`, review);
  await store.setJSON(rateKey, { time: now });

  return json({ ok: true, review }, 201);
};

export const config = { path: "/api/reviews" };
