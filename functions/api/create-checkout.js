/**
 * ============================================================
 * 東欧のキッチン — /api/create-checkout
 * Cloudflare Workers (Pages Functions) 実装
 *
 * ファイルパス: functions/api/create-checkout.js
 * ============================================================
 *
 * 【cloudcold / Cloudflare Pages での配置方法】
 *
 * プロジェクト構成:
 *   your-project/
 *   ├── functions/
 *   │   └── api/
 *   │       ├── create-checkout.js   ← このファイル
 *   │       └── session-result.js    ← 決済確認用（任意）
 *   ├── public/
 *   │   ├── index.html               ← eastern-europe-ec-v6.html をリネーム
 *   │   ├── success.html
 *   │   └── cancel.html
 *   └── package.json
 *
 * 【環境変数の設定】
 * Cloudflare ダッシュボード:
 *   Workers & Pages → あなたのプロジェクト
 *   → Settings → Environment Variables
 *     STRIPE_SECRET_KEY = sk_live_xxxxx（本番）/ sk_test_xxxxx（テスト）
 *     CLIENT_URL        = https://あなたのドメイン
 *
 * ============================================================
 */

// ============================================================
// 商品マスタ（金額・商品名はサーバーで管理 → 改ざん防止）
// priceId は Stripe ダッシュボードで作成したものを使用
// ============================================================
const ALLOWED_PRICE_IDS = new Set([
  'price_1TNRp5CYgYx6cZLVOMqHFBFx_pirozhki_meat',
  'price_1TNn64CYgYx6cZLVHhSaDXIz_pirozhki_veggie',
  'price_1TNRocCYgYx6cZLVD9p8g7Db_pelmeni_400g',
  'price_1TNn7LCYgYx6cZLV2z8cAVRN_pelmeni_800g',
  'price_1TNn8BCYgYx6cZLVUPAqzder_set_intro_meat',
  'price_XXXXXXXXXX_set_intro_veggie',
  'price_1TNn8bCYgYx6cZLVAfne2dvI_set_full',
  'price_1TNn98CYgYx6cZLV050NK4Ee_set_pirozhki',
  // ⚠️ Stripe ダッシュボードで発行した実際の Price ID に書き換えること
]);

// ============================================================
// POSTハンドラ
// ============================================================
export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS ヘッダー
  const corsHeaders = {
    'Access-Control-Allow-Origin':  env.CLIENT_URL || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // ---- リクエストボディ取得 ----
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'リクエスト形式が不正です。' }, 400, corsHeaders);
  }

  const { lineItems } = body;

  // ---- バリデーション ----
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    return jsonResponse({ error: 'カートが空です。' }, 400, corsHeaders);
  }

  // 各 lineItem のチェック
  for (const item of lineItems) {
    const { priceId, quantity } = item;

    // priceId が許可リストに存在するか確認（改ざん防止）
    if (!priceId || !ALLOWED_PRICE_IDS.has(priceId)) {
      return jsonResponse(
        { error: `不正な商品IDが含まれています: ${priceId}` },
        400,
        corsHeaders
      );
    }

    // 数量チェック
    const qty = parseInt(quantity, 10);
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
      return jsonResponse(
        { error: `数量が不正です（1〜99の整数を指定してください）` },
        400,
        corsHeaders
      );
    }
  }

  // ---- Stripe Checkout Session 作成 ----
  const stripeKey = env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('STRIPE_SECRET_KEY が設定されていません');
    return jsonResponse(
      { error: 'サーバーの設定エラーです。管理者にお問い合わせください。' },
      500,
      corsHeaders
    );
  }

  const clientUrl = env.CLIENT_URL || 'https://example.com';

  // Stripe API へ直接 fetch（Cloudflare Workers は Node.js ではないため）
  const stripePayload = {
    mode: 'payment',
    payment_method_types: ['card'],

    // line_items を URL エンコード形式に変換（Stripe API は form-encoded）
    ...buildLineItems(lineItems),

    success_url: `${clientUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${clientUrl}/cancel`,
    locale:      'ja',

    // 配送先住所を収集（冷凍食品のため必須）
    'shipping_address_collection[allowed_countries][0]': 'JP',

    // 電話番号収集
    'phone_number_collection[enabled]': 'true',

    // 配送オプション（クール便 ¥880）
    'shipping_options[0][shipping_rate_data][type]':         'fixed_amount',
    'shipping_options[0][shipping_rate_data][display_name]': '冷凍クール便',
    'shipping_options[0][shipping_rate_data][fixed_amount][amount]':   '880',
    'shipping_options[0][shipping_rate_data][fixed_amount][currency]': 'jpy',
    'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][unit]':  'business_day',
    'shipping_options[0][shipping_rate_data][delivery_estimate][minimum][value]': '3',
    'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][unit]':  'business_day',
    'shipping_options[0][shipping_rate_data][delivery_estimate][maximum][value]': '5',

    'metadata[source]': 'eastern-europe-ec',
  };

  try {
    const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: toFormEncoded(stripePayload),
    });

    const session = await stripeRes.json();

    if (!stripeRes.ok) {
      console.error('[Stripe Error]', session.error);
      return jsonResponse(
        { error: session.error?.message || 'Stripe決済の開始に失敗しました。' },
        stripeRes.status,
        corsHeaders
      );
    }

    // 決済URLをフロントへ返す
    return jsonResponse({ url: session.url }, 200, corsHeaders);

  } catch (err) {
    console.error('[Fetch Error]', err);
    return jsonResponse(
      { error: 'サーバーエラーが発生しました。しばらく経ってから再度お試しください。' },
      500,
      corsHeaders
    );
  }
}

// ============================================================
// OPTIONSハンドラ（CORS preflight）
// ============================================================
export async function onRequestOptions(context) {
  const { env } = context;
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin':  env.CLIENT_URL || '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ============================================================
// ヘルパー関数
// ============================================================

/** line_items を form-encoded 用オブジェクトに展開 */
function buildLineItems(lineItems) {
  const result = {};
  lineItems.forEach((item, i) => {
    result[`line_items[${i}][price]`]    = item.priceId;
    result[`line_items[${i}][quantity]`] = String(parseInt(item.quantity, 10));
  });
  return result;
}

/** オブジェクトを application/x-www-form-urlencoded 文字列に変換 */
function toFormEncoded(obj) {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** JSON レスポンスを返す */
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}
