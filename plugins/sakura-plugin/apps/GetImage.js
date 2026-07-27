import { FlipImage } from "../lib/ImageUtils/ImageUtils.js";
import _ from "lodash";

// konachan 用 .net 而非 .com：后者被 Cloudflare 拦在 403，伪造 UA 也无效
// （TLS 指纹级别的拦截），原先正是为此才要走 puppeteer-real-browser。
// .net 是同一套数据库的 SFW 镜像，裸 fetch 即可，无需浏览器环境。
const IMAGE_SOURCES = {
  yande: {
    url: "https://yande.re/post.json?tags=loli+-rating:e+-nipples&limit=500",
  },
  konachan: {
    url: "https://konachan.net/post.json?tags=loli+-rating:e+-nipples&limit=500",
  },
};

export class GetImagePlugin extends plugin {
  constructor() {
    super({
      name: "GetImage",
      event: "message",
      priority: 1135,
    });
  }

  handleImage = Command(/^#?来张萝莉图(y|k)?$/, async (e) => {
    const sourceMap = {
      y: "yande",
      k: "konachan",
    };


    let suffix = e.match?.[1];
    if (!suffix) {
      suffix = Math.random() < 0.9 ? "y" : "k";
    }

    const sourceKey = sourceMap[suffix];
    return await this.fetchAndSendImage(e, sourceKey);
  });

  async fetchAndSendImage(e, sourceKey) {
    const sourceConfig = IMAGE_SOURCES[sourceKey];

    await e.react(124);

    let jsonData;

    try {
      const response = await fetch(sourceConfig.url);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      jsonData = await response.json();

      if (Array.isArray(jsonData) && jsonData.length > 0) {
        const imageUrls = jsonData
          .map((item) => item?.file_url)
          .filter((url) => url);

        if (imageUrls.length > 0) {
          const imageUrl = _.sample(imageUrls);
          const sendResult = await e.reply(segment.image(imageUrl));

          if (!sendResult?.message_id) {
            logger.warn(
              `图片发送失败(${sourceKey}): ${imageUrl}，尝试备用方案...`
            );
            await e.reply("图片发送失败，正在尝试翻转图片...", 10, true);

            const flippedBuffer = await FlipImage(imageUrl);
            if (flippedBuffer) {
              const finalSendResult = await e.reply(
                segment.image(flippedBuffer)
              );
              if (!finalSendResult?.message_id) {
                await e.reply("翻转后图片也发送失败，可能图片太色了", 10, true);
              }
            } else {
              await e.reply("图片翻转失败", 10, true);
            }
          }
        } else {
          logger.warn("没有获取到有效的图片URL");
          await e.reply("获取失败,没有有效的图片URL", 10, true);
        }
      } else {
        await e.reply("获取失败,没有获取到有效的图片数据", 10, true);
      }
    } catch (error) {
      logger.error(`整体处理流程出错:`, error);
      await e.reply("获取失败,发生错误，请稍后再试", 10, true);
    }
  }
}
