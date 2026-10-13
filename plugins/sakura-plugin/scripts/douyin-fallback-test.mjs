import assert from "node:assert/strict";
import test from "node:test";
import puppeteer from "puppeteer";
import { DouyinService, DOUYIN_API_USER_AGENT } from "../lib/douyin/douyinService.js";
import { generateABogus, generateReplyABogus } from "../lib/douyin/aBogus.js";

const AWEME_ID = "7690803400716511589";
const OTHER_ID = "7372484719365098803";
const SOURCE_URL = `https://www.douyin.com/video/${AWEME_ID}`;
const COOKIE = "sessionid=test-session; ttwid=test-access";
const detail = {
  aweme_id: AWEME_ID,
  desc: "桌面作品",
  video: {
    duration: 7500,
    play_addr: { url_list: ["https://v3.douyinvod.com/test.mp4"] },
  },
};

test("直接请求携带同源网关凭据并取得一级、二级评论，全程不启用浏览器", async () => {
  const originalNow = Date.now;
  const originalRandom = Math.random;
  Date.now = () => 1700000000000;
  Math.random = () => 0.5;
  const sourceCookie = "sessionid=test; UIFID=current-device; UIFID_TEMP=temporary-device; s_v_web_id=verify-current; msToken=current-token";
  const requests = [];
  const service = new DouyinService({
    fetchImpl: async (rawUrl, { headers }) => {
      const url = new URL(rawUrl);
      requests.push(url.pathname);
      assert.equal(headers["x-tt-argus"], "1");
      assert.equal(headers.uifid, "current-device");
      assert.equal(headers.cookie, sourceCookie);
      assert.equal(url.searchParams.get("verifyFp"), "verify-current");
      assert.equal(url.searchParams.get("fp"), "verify-current");
      assert.equal(url.searchParams.get("msToken"), "current-token");
      const signature = url.searchParams.get("a_bogus");
      url.searchParams.delete("a_bogus");
      const isReply = url.pathname.endsWith("/reply/");
      assert.equal(signature, (isReply ? generateReplyABogus : generateABogus)(
        url.searchParams.toString(), DOUYIN_API_USER_AGENT
      ));
      if (url.pathname.endsWith("/aweme/detail/")) {
        assert.equal(url.searchParams.get("uifid"), "current-device");
        return new Response(JSON.stringify({ aweme_detail: detail }));
      }
      if (isReply) {
        return new Response(JSON.stringify({ status_code: 0, comments: [
          { cid: "2000000001", text: "二级回复", user: { nickname: "回复用户" } },
        ] }));
      }
      return new Response(JSON.stringify({ status_code: 0, total: 1, comments: [
        { cid: "1000000001", text: "一级评论", reply_comment_total: 1, user: { nickname: "评论用户" } },
      ] }));
    },
  });
  service.fetchBrowserDetail = async () => assert.fail("正常接口不应启动作品浏览器");
  service.refreshBrowserCookies = async () => assert.fail("正常接口不应刷新浏览器 Cookie");
  try {
    const aweme = await service.getAwemeDetail(SOURCE_URL, { cookie: sourceCookie });
    const result = await service.getTopComments(aweme, { cookie: sourceCookie, replyLimit: 3 });
    assert.equal(result.comments[0].text, "一级评论");
    assert.equal(result.comments[0].replies[0].text, "二级回复");
    assert.deepEqual(requests, [
      "/aweme/v1/web/aweme/detail/", "/aweme/v1/web/comment/list/", "/aweme/v1/web/comment/list/reply/",
    ]);
    assert.equal(service.buildApiHeaders("UIFID_TEMP=temporary-device").uifid, "temporary-device");
    assert.equal(service.buildHeaders(sourceCookie).uifid, undefined);
    assert.equal(service.buildHeaders(sourceCookie)["x-tt-argus"], undefined);
  } finally {
    Date.now = originalNow;
    Math.random = originalRandom;
  }
});

test("二级回复签名使用独立协议参数，固定时钟下保持已验证的签名结果", () => {
  const query = "aid=6383&item_id=7690803400716511589&comment_id=7692502753809974054&cursor=0&count=3";
  const options = { now: () => 1700000000000, random: () => 0.5 };
  const reply = generateReplyABogus(query, "test-agent", options);
  assert.equal(reply,
    "xfmZ/RLDDi2sDDWv56KLfY3q6IN3Yg/I0trEMD2fOV3lqL39HMYD9exEIBGvXY8jwG/-IeYjy4hbT3ohrQ2y8qwf9W0L/25gsDSkKl12so0j53inCLf/E0iE5hsAtFH8svr4iKi8owICSYyhldAJ5kIlO62-zo0/93D=");
  assert.notEqual(reply, generateABogus(query, "test-agent", options));
});

test("详情接口被拦截时直接读取桌面作品，不再先启动浏览器重复 Cookie 重试", async () => {
  let browserCalls = 0;
  let apiCalls = 0;
  const service = new DouyinService({
    browserCookieProvider: async () => assert.fail("不应先刷新 Cookie 再重试相同接口"),
    fetchImpl: async (url) => {
      assert.equal(new URL(url).pathname, "/aweme/v1/web/aweme/detail/");
      apiCalls += 1;
      return new Response("", { status: 403 });
    },
  });
  service.fetchBrowserDetail = async (id, sourceCookie) => {
    browserCalls += 1;
    assert.equal(id, AWEME_ID);
    assert.equal(sourceCookie, COOKIE);
    service.browserCookieCache = {
      sourceCookie: COOKIE,
      cookieHeader: "ttwid=desktop-cookie",
      expiresAt: Date.now() + 60_000,
    };
    return detail;
  };

  const result = await service.getAwemeDetail(SOURCE_URL, { cookie: COOKIE });
  assert.equal(result.id, AWEME_ID);
  assert.equal(result.streams.length, 1);
  assert.equal(result.duration, 8);
  assert.equal(browserCalls, 1);
  assert.equal(apiCalls, 1);
  assert.equal(service.getCachedBrowserCookie(COOKIE), "ttwid=desktop-cookie");
});

test("关闭浏览器回退时不启动浏览器，并保留原访问验证错误", async () => {
  const service = new DouyinService({
    browserCookieProvider: async () => assert.fail("不应读取浏览器 Cookie"),
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/aweme/v1/web/aweme/detail/") {
        return new Response("", { status: 403 });
      }
      return new Response("", { status: 200 });
    },
  });
  service.fetchBrowserDetail = async () => assert.fail("不应读取桌面详情");
  await assert.rejects(
    service.getAwemeDetail(SOURCE_URL, { browserFallback: false }),
    (error) => error.code === "DOUYIN_BLOCKED"
  );
});

test("桌面浏览器失败后仍可通过旧接口取得作品", async () => {
  const service = new DouyinService({
    browserCookieProvider: async () => "ttwid=refreshed-cookie",
    fetchImpl: async (url) => {
      if (new URL(url).pathname === "/aweme/v1/web/aweme/detail/") {
        return new Response("", { status: 403 });
      }
      return new Response(JSON.stringify({ item_list: [detail] }));
    },
  });
  service.fetchBrowserDetail = async () => { throw new Error("浏览器启动失败"); };
  const result = await service.getAwemeDetail(SOURCE_URL);
  assert.equal(result.id, AWEME_ID);
  assert.equal(result.streams.length, 1);
});

// 模拟网页自己的响应，验证详情筛选和浏览器释放，不依赖抖音在线状态。
async function withBrowserPage({ responses = [], html = "", navigationError = null }, run) {
  const originalLaunch = puppeteer.launch;
  let predicate;
  let finishWait;
  let closed = false;
  const accepted = [];
  const page = {
    setUserAgent: async () => {},
    setViewport: async () => {},
    setRequestInterception: async () => {},
    on: () => {},
    setCookie: async () => {},
    waitForResponse: (filter) => {
      predicate = filter;
      return new Promise((resolve) => { finishWait = resolve; });
    },
    goto: async (url) => {
      assert.equal(url, SOURCE_URL);
      if (navigationError) { finishWait(null); throw navigationError; }
      for (const { url: responseUrl, body, status = 200 } of responses) {
        const matched = await predicate({
          url: () => responseUrl,
          ok: () => status >= 200 && status < 300,
          text: async () => JSON.stringify(body),
        });
        accepted.push(matched);
        if (matched) break;
      }
      finishWait(null);
    },
    content: async () => html,
    cookies: async () => [{ name: "ttwid", value: "desktop-cookie" }],
  };
  puppeteer.launch = async () => ({
    newPage: async () => page,
    close: async () => { closed = true; },
  });
  try {
    await run({ accepted });
    assert.equal(closed, true);
  } finally {
    puppeteer.launch = originalLaunch;
  }
}

test("桌面详情只接受同源、同 ID 且含媒体的数据，忽略推荐作品和空详情", async () => {
  const endpoint = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${AWEME_ID}`;
  await withBrowserPage({ responses: [
    { url: endpoint.replace("www.douyin.com", "other.example"), body: { aweme_detail: detail } },
    { url: endpoint.replace(AWEME_ID, OTHER_ID), body: { aweme_detail: detail } },
    { url: endpoint, body: { aweme_detail: { ...detail, aweme_id: OTHER_ID } } },
    { url: endpoint, body: { aweme_detail: { aweme_id: AWEME_ID } } },
    { url: endpoint, body: { aweme_detail: detail } },
  ] }, async ({ accepted }) => {
    const service = new DouyinService();
    const result = await service.fetchBrowserDetail(AWEME_ID, COOKIE);
    assert.deepEqual(result, detail);
    assert.deepEqual(accepted, [false, false, false, false, true]);
    assert.equal(service.getCachedBrowserCookie(COOKIE),
      "sessionid=test-session; ttwid=desktop-cookie");
  });
});

test("无详情响应时可读取当前作品的页面数据，跳过同 ID 元数据和其他作品", async () => {
  const root = {
    route: { awemeId: AWEME_ID },
    recommended: { ...detail, aweme_id: OTHER_ID },
    current: detail,
  };
  await withBrowserPage({
    html: `<script id="RENDER_DATA">${encodeURIComponent(JSON.stringify(root))}</script>`,
  }, async () => {
    const result = await new DouyinService().fetchBrowserDetail(AWEME_ID);
    assert.deepEqual(result, detail);
  });
});

test("登录提示的封面元数据不能冒充可下载图文，失败时也关闭浏览器", async () => {
  await withBrowserPage({
    html: '<meta property="og:description" content="请登录"><meta property="og:image" content="https://p3.douyinpic.com/login.jpg">',
  }, async () => {
    await assert.rejects(
      new DouyinService().fetchBrowserDetail(AWEME_ID),
      (error) => error.code === "DOUYIN_BROWSER_DETAIL_FAILED"
    );
  });
  await withBrowserPage({ navigationError: new Error("导航失败") }, async () => {
    await assert.rejects(new DouyinService().fetchBrowserDetail(AWEME_ID), /导航失败/);
  });
});
