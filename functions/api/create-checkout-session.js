/**
 * ============================================================
 * 東欧のキッチン — Stripe Checkout Session 作成 API
 *
 * ファイルパス: functions/api/create-checkout-session.js
 * 対応形式    : Cloudflare Pages Functions (ES Modules)
 * ============================================================
 *
 * 【対応エンドポイント】
 *   POST /api/create-checkout-session
 *
 * 【リクエスト形式】
 *   単品:   { "productId": "p1" }
 *   複数:   { "products": [{ "productId": "p1", "quantity": 2 }, ...] }
 *
 * 【レスポンス形式】
 *   成功: { "url": "https://checkout.stripe.com/..." }
 *   失敗: { "error": "エラーメッセージ" }
 *
 * 【Cloudflare 環境変数】（ダッシュボード > Settings > Environment Variables）
 *   STRIPE_SECRET_KEY : sk_live_xxxx または sk_test_xxxx
 *   CLIENT_URL        : https://あなたのドメイン（末尾スラッシュなし）
 * ============================================================
 */

// ============================================================
// 商品マスタ（金額・名称はサーバー側で完全管理 → 改ざん防止）
// productId (p1〜p7) とフロントの data-product 属性が必ず一致すること
// ============================================================
const PRODUCTS = {
  p1: {
    name:       'ピロシキ（ジューシーミート）4個入り',
    amount:     1680,      // 円（JPY は整数）
    currency:   'jpy',
    description: '牛豚合挽き肉入り 東欧の揚げパン',
  },
  p2: {
    name:       'ピロシキ（たまごとキャベツ）4個入り',
    amount:     1680,
    currency:   'jpy',
    description: 'たまご・キャベツ・玉ねぎ入り 東欧の揚げパン',
  },
  p3: {
    name:       '東欧の水餃子 ペリメニ 400g',
    amount:     1480,
    currency:   'jpy',
    description: '牛豚合挽き肉入り 手作り水餃子',
  },
  p4: {
    name:       '東欧の水餃子 ペリメニ 800g（お得サイズ）',
    amount:     2780,
    currency:   'jpy',
    description: '牛豚合挽き肉入り 手作り水餃子 大容量（通常¥2,960）',
  },
  p5: {
    name:       'はじめての東欧セット',
    amount:     2980,
    currency:   'jpy',
    description: 'ピロシキ4個 + ペリメニ400g のお得なセット',
  },
  p6: {
    name:       '満足セット',
    amount:     5480,
    currency:   'jpy',
    description: 'ピロシキ8個（ミート4+野菜4） + ペリメニ800g',
  },
  p7: {
    name:       'ピロシキ食べ比べセット',
    amount:     1480,
    currency:   'jpy',
    description: 'ジューシーミート×2 + たまごとキャベツ×2（計4個）',
  },
};

// ============================================================
// CORS ヘッダー生成
// ============================================================
function corsHeaders(clientUrl) {
  return {
    'Access-Control-Allow-Origin':  clientUrl || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// ============================================================
// JSON レスポンスヘルパー
// ============================================================
function jsonRes(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

// ============================================================
// Stripe API 呼び出し（fetch で直接）
// Cloudflare Workers は Node.js 環境ではないため
// stripe npm パッケージではなく fetch を使用する
// ============================================================
async function createStripeSession(secretKey, payload) {
  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: toFormEncoded(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.error?.message || `Stripe API エラー: ${res.status}`);
  }

  return data; // session オブジェクト
}

// ============================================================
// line_items を form-encoded 形式に展開
// ============================================================
function buildLineItemsPayload(lineItems) {
  const result = {};
  lineItems.forEach(({ name, amount, currency, description, quantity }, i) => {
    result[`line_items[${i}][price_data][currency]`]                 = currency;
    result[`line_items[${i}][price_data][unit_amount]`]              = String(amount);
    result[`line_items[${i}][price_data][product_data][name]`]       = name;
    result[`line_items[${i}][price_data][product_data][description]`] = description || '';
    result[`line_items[${i}][quantity]`]                              = String(quantity);
  });
  return result;
}

// ============================================================
// オブジェクト → application/x-www-form-urlencoded 変換
// ============================================================
function toFormEncoded(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

// ============================================================
// OPTIONS: CORS preflight 対応
// ============================================================
export async function onRequestOptions({ env }) {
  return new Response(null, {
    status:  204,
    headers: corsHeaders(env.CLIENT_URL),
  });
}

// ============================================================
// POST: Checkout Session 作成
// ============================================================
export async function onRequestPost({ request, env }) {
  const cors = corsHeaders(env.CLIENT_URL);

  // ── 環境変数チェック ──────────────────────────────────────
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error('STRIPE_SECRET_KEY が設定されていません');
    return jsonRes({ error: 'サーバー設定エラーです。管理者にお問い合わせください。' }, 500, cors);
  }

  const clientUrl = env.CLIENT_URL || 'https://example.com';

  // ── リクエストボディ取得 ──────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonRes({ error: 'リクエスト形式が不正です（JSONが必要です）。' }, 400, cors);
  }

  // ── 商品リスト組み立て（単品 or 複数）────────────────────
  let lineItems = [];

  if (body.productId) {
    // 【単品】 { productId: "p1" }
    const product = PRODUCTS[body.productId];
    if (!product) {
      return jsonRes({ error: `不明な商品IDです: ${body.productId}` }, 400, cors);
    }
    lineItems.push({ ...product, quantity: 1 });

  } else if (Array.isArray(body.products) && body.products.length > 0) {
    // 【複数】 { products: [{ productId: "p1", quantity: 2 }, ...] }
    for (const item of body.products) {
      const product = PRODUCTS[item.productId];
      if (!product) {
        return jsonRes({ error: `不明な商品IDです: ${item.productId}` }, 400, cors);
      }
      const qty = parseInt(item.quantity, 10);
      if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
        return jsonRes({ error: `数量が不正です: ${item.productId} (${item.quantity})` }, 400, cors);
      }
      lineItems.push({ ...product, quantity: qty });
    }

  } else {
    return jsonRes({ error: 'productId または products が必要です。' }, 400, cors);
  }

  // ── Stripe Checkout Session 作成 ─────────────────────────
  try {
    const payload = {
      mode: 'payment',
      'payment_method_types[0]': 'card',

      // line_items（動的に展開）
      ...buildLineItemsPayload(lineItems),

      // リダイレクト先
      success_url: `${clientUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
cancel_url: `${clientUrl}/cancel.html`,

      // 日本語表示
      locale: 'ja',

      // 配送先住所（日本国内のみ）
      'shipping_address_collection[allowed_countries][0]': 'JP',

      // 電話番号収集
      'phone_number_collection[enabled]': 'true',

      // 冷凍クール便 送料
      'shipping_options[0][shipping_rate_data][type]':                             'fixed_amount',
      'shipping_options[0][shipping_rate_data][display_name]':                     '冷凍クール便',
      'shipping_options[0][shipping_rate_data][fixed_amount][amount]':             '880',
      'shipping_options[0][shipping_rate_data][fixed_amount][currency]':           'jpy',
      'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]': 'business_day',
      'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]':'3',
      'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]': 'business_day',
      'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]':'5',

      // メタデータ
      'metadata[source]': 'eastern-europe-ec',
    };

    const session = await createStripeSession(secretKey, payload);

    // ── 成功: 決済URLを返す ───────────────────────────────
    return jsonRes({ url: session.url }, 200, cors);

  } catch (err) {
    console.error('[Stripe Error]', err.message);
    return jsonRes(
      { error: err.message || '決済の開始に失敗しました。しばらくしてから再度お試しください。' },
      500,
      cors
    );
  }
}
