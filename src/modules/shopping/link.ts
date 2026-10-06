// Reading a product page someone pasted into Shop Scan. Only well-known Indian fashion shops (and
// their image CDNs) are fetched, over https, with every redirect re-checked, so the server can't be
// pointed at arbitrary or internal addresses (SSRF). Parsing is pure and unit-tested.

export const SHOP_HOSTS = [
  "myntra.com", "ajio.com", "amazon.in", "flipkart.com", "hm.com", "zara.com", "nykaafashion.com",
  "tatacliq.com", "meesho.com", "uniqlo.com", "snitch.co.in", "bewakoof.com", "thesouledstore.com",
  "westside.com", "maxfashion.in", "fabindia.com", "libas.in", "biba.in",
];
export const IMAGE_HOSTS = [
  ...SHOP_HOSTS, "myntassets.com", "media-amazon.com", "ssl-images-amazon.com", "flixcart.com", "rukminim1.flixcart.com",
  "zara.net", "hmgoepprod.azureedge.net", "image.hm.com", "assets.ajio.com", "cdn.shopify.com", "shopify.com",
];

/** https URL whose host is one of `hosts` or a subdomain of one. */
export function isAllowedUrl(raw: string, hosts: string[]): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`)) ? u : null;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();

function meta(html: string, key: string): string | null {
  // <meta property="og:image" content="..."> in either attribute order.
  const a = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']+)["']`, "i").exec(html);
  const b = new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${key}["']`, "i").exec(html);
  const v = a?.[1] ?? b?.[1];
  return v ? decode(v) : null;
}

/** Title, main image and price from Open Graph tags, falling back to schema.org Product JSON-LD. */
export function parseProductMeta(html: string, pageUrl: string): { title: string | null; image: string | null; price: string | null } {
  let title = meta(html, "og:title") ?? meta(html, "twitter:title");
  let image = meta(html, "og:image") ?? meta(html, "og:image:secure_url") ?? meta(html, "twitter:image");
  let price = meta(html, "product:price:amount") ?? meta(html, "og:price:amount");
  if (!title || !image) {
    for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const data = JSON.parse(m[1]);
        const nodes = (Array.isArray(data) ? data : [data, ...(data?.["@graph"] ?? [])]) as Record<string, unknown>[];
        const product = nodes.find((n) => n && (n["@type"] === "Product" || (Array.isArray(n["@type"]) && (n["@type"] as string[]).includes("Product"))));
        if (product) {
          title ??= typeof product.name === "string" ? product.name : null;
          const img = product.image;
          image ??= typeof img === "string" ? img : Array.isArray(img) && typeof img[0] === "string" ? img[0] : null;
          const offers = (Array.isArray(product.offers) ? product.offers[0] : product.offers) as { price?: string | number } | undefined;
          price ??= offers?.price != null ? String(offers.price) : null;
        }
      } catch {
        /* malformed JSON-LD: ignore */
      }
    }
  }
  if (!title) title = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  // Protocol-relative and relative image URLs become absolute.
  if (image) {
    try {
      image = new URL(image.startsWith("//") ? `https:${image}` : image, pageUrl).toString();
    } catch {
      image = null;
    }
  }
  return { title: title ? decode(title).slice(0, 200) : null, image, price };
}
