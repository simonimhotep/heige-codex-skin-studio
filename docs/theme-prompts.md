# 主题提示词库

8 套可以直接复制的背景生图提示词。生成一张干净底图，交给 Skin Studio 就是一套主题：菜单上传、`customize.command`、或把 `.skill` 交给 Codex 让它全自动做完，三条路都行，见 [README](../README.md#用一张图做你自己的主题)。

## 先记住五条规矩

1. **尺寸**：16:9，推荐 `2560 × 1440`。提示词里写了尺寸，生成器的尺寸参数也要设，两边都设才稳；不支持就先出 16:9 高清图再等比缩放，别拉伸。
2. **画面必须干净**：`no text, no watermark, no logo, no UI` 必须写进提示词。文字和控件交给 Codex 原生界面，烘进背景里的字会被裁、会糊、会乱码。
3. **构图留呼吸**：主体放右三分之一，左侧留大面积安全区给侧栏和对话区。做成主题后可用 `previewFocus` 微调看板焦点，见[完整手册](manual.md#极简主题格式)。
4. **人物一律原创虚构**：真人明星、别人的版权角色，别放进公开分发的主题。自己电脑上怎么玩都行，公开发布前先过一遍 [ASSET_PROVENANCE.md](../ASSET_PROVENANCE.md) 的登记方式。
5. **亮度配外观**：深色图配 dark，浅色图配 light。工具会自动判断，不合意再在 Codex 设置里手动改。

每套提示词都是英文主体加中文说明。英文是给生成器的，中文告诉你这套适合什么心情。

## 01 · 青蓝歌姬

蓝粉双色，舞台感，适合喜欢虚拟歌手氛围但想要原创形象的人。建议 dark。

```text
2560x1440 anime wallpaper, 16:9, an original fictional adult virtual singer with long teal twin-tails, standing on the right third of the frame, glowing stage lights in cyan and soft pink, dark navy background with floating holographic music notes, generous empty space on the left, cinematic rim lighting, high detail, clean composition, no text, no watermark, no logo, no UI elements
```

## 02 · 晨光原野

浅色治愈系，草原、晨雾、远山，适合白天写代码不想太刺激的眼睛。建议 light。

```text
2560x1440 fantasy landscape wallpaper, 16:9, sunlit grassland at dawn with soft morning mist, distant blue mountains and floating islands, warm golden light from the right, pastel green and sky-blue palette, wide open sky taking the upper half, no characters, painterly anime background style, high detail, no text, no watermark, no logo, no UI elements
```

## 03 · 星夜山海

深蓝星空加山脊剪影，安静，适合深夜赶工。建议 dark。

```text
2560x1440 night landscape wallpaper, 16:9, a vast starry sky over layered mountain silhouettes, a faint galaxy band rising on the right, deep indigo and violet palette with a few warm lantern lights in a distant valley, tranquil and quiet mood, anime background art style, high detail, no text, no watermark, no logo, no UI elements
```

## 04 · 赛博潮汐

霓虹雨夜都市，蓝紫为主，适合喜欢赛博感的人。建议 dark。

```text
2560x1440 cyberpunk city wallpaper, 16:9, rain-soaked neon metropolis at night viewed from a rooftop, glowing holographic waves rolling between skyscrapers on the right, electric blue and magenta palette with teal reflections on wet surfaces, left side fading into dark mist for negative space, cinematic atmosphere, high detail, no text, no watermark, no logo, no UI elements
```

## 05 · 热血晚霞

橙红晚霞下的村落剪影，少年感，适合打鸡血的下午。建议 dark。

```text
2560x1440 anime scenery wallpaper, 16:9, a hidden village of wooden rooftops in a valley under a blazing orange sunset, dramatic clouds streaked with crimson and gold, a lone banner pole silhouetted on the right ridge, warm amber palette cooling into dusk purple at the edges, heroic nostalgic mood, high detail, no text, no watermark, no logo, no UI elements
```

## 06 · 星海恋语

深空紫粉星轨，柔光，适合想要一点浪漫的人。建议 dark。

```text
2560x1440 romantic space wallpaper, 16:9, a dreamy deep-space vista with soft nebula clouds in rose pink and violet, glittering star trails curving toward the upper right, a small crystalline planet glowing gently on the right third, silky gradient background, elegant and tender mood, high detail, no text, no watermark, no logo, no UI elements
```

## 07 · 治愈粘土

粘土质感 3D 小世界，圆润软萌，适合想被治愈的日子。建议 light。

```text
2560x1440 claymation style 3D wallpaper, 16:9, a cozy miniature clay world with rounded hills, tiny handmade houses and soft clay clouds, an original chubby clay mascot character waving on the right third, warm cream and mint palette with soft studio lighting, gentle shadows, handcrafted texture with visible fingerprints, adorable healing mood, no text, no watermark, no logo, no UI elements
```

## 08 · 水墨留白

新中式水墨山水，大面积留白，适合想要安静和克制的人。建议 light。

```text
2560x1440 chinese ink painting wallpaper, 16:9, minimalist shan-shui landscape with a few bold ink strokes forming distant peaks on the right, vast empty rice-paper white space on the left, a tiny boat on calm water, one accent of vermilion red seal-like color, elegant negative space composition, subtle paper texture, no text, no calligraphy, no watermark, no logo, no UI elements
```

## 生成完之后

1. 检查四件事：比例是 16:9、画面里没有文字和水印、主体不在正中间挡对话区、亮度和你想要的外观一致。
2. 交给 Skin Studio：菜单上传最快；想留档就用 `customize.command` 做成正式主题；懒得动手就把 `.skill` 连图一起丢给 Codex。
3. **晒出来**：好看的主题自己看太浪费。来[晒图区](https://github.com/HeiGeAi/heige-codex-skin-studio/discussions)贴真机截图，或用[主题晒图模板](https://github.com/HeiGeAi/heige-codex-skin-studio/issues/new/choose)投稿，写上主题名和你用的提示词。被选中的主题会进 README 精选，署你的名。
