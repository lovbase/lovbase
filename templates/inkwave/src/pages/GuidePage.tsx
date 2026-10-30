import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default function GuidePage() {
  const en = new URLSearchParams(location.search).get('lang') === 'en'
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6 md:p-8" lang={en ? 'en' : 'zh-CN'}>
      <a className="underline underline-offset-4" href={import.meta.env.BASE_URL}>
        {en ? '← Back to game' : '← 返回游戏'}
      </a>
      <h1 className="text-2xl font-semibold tracking-tight">
        {en ? 'INKWAVE · Game guide' : 'INKWAVE 墨浪对战 · 对战说明'}
      </h1>
      <p className="text-muted-foreground">
        {en
          ? 'A browser-based 3D turf war. Play 5v5 matches with bots filling empty slots.'
          : '在浏览器中进入 3D 涂墨战场，为队伍争夺地面。游戏提供 5v5 对局，空缺位置由机器人补齐。'}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>{en ? 'How to play' : '怎么玩？'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>
            {en
              ? 'Choose a shooter, roller, charger or blaster and cover more ground with your team’s ink.'
              : '选择射击枪、滚筒、蓄力枪或爆破枪，用队伍的墨水覆盖更多场地。'}
          </p>
          <p>
            {en
              ? 'Desktop: WASD to move, mouse to aim, left click to shoot, Shift to swim, Space to jump and Esc for the menu.'
              : '电脑：WASD 移动，鼠标瞄准，左键射击，Shift 潜游，空格跳跃，Esc 打开菜单。'}
          </p>
          <p>
            {en
              ? 'Mobile: rotate to landscape. Move with the left joystick, drag on the right to aim, and use the touch buttons to shoot, jump, swim, throw bombs and activate specials.'
              : '手机：请横屏游玩。左侧摇杆移动，右侧滑动瞄准，使用触摸按钮射击、跳跃、潜游、投掷炸弹和释放大招。'}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{en ? 'Invite friends' : '如何邀请朋友联机？'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>
            {en
              ? 'Open Multiplayer, choose browser direct, create a room and share its invitation link or room code. Once friends join, the host starts the match and must keep the page open.'
              : '打开多人游戏，选择浏览器直连，由一名玩家创建房间并分享邀请链接或房间码。其他玩家加入后，由房主开始对局；房主需要保持页面开启。'}
          </p>
          <p className="text-muted-foreground">
            {en
              ? 'Direct play depends on PeerJS signaling and WebRTC. Restricted networks or some NAT configurations may prevent connections; no TURN relay is deployed.'
              : '直连依赖 PeerJS 公共信令和 WebRTC；部分 NAT 或受限网络可能连接失败，目前没有部署 TURN 中继，不保证所有网络都能连接。'}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{en ? 'Turn your idea into an app' : '也想把想法变成应用？'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p>
            {en
              ? 'This port was built with Lovbase. Describe your idea in natural language to create an app with an interface and database.'
              : '此版本使用 Lovbase 完成应用移植。你也可以用自然语言描述需求，在 Lovbase 创建带界面和数据库的应用。'}
          </p>
          <a
            className="inline-block rounded-lg bg-primary px-4 py-2 text-primary-foreground"
            href="https://lovbase.dev/?utm_source=inkwave&utm_medium=referral&utm_campaign=built_with_lovbase&utm_content=game_info"
            target="_blank"
            rel="noopener noreferrer"
          >
            {en ? 'Build your app with Lovbase ↗' : '前往 Lovbase，创建你的应用 ↗'}
          </a>
        </CardContent>
      </Card>
      <footer className="border-t pt-4 text-sm text-muted-foreground">
        {en ? 'Original game: ' : '原游戏：'}
        <a
          className="underline"
          href="https://github.com/caoxing9/inkwave-game"
          target="_blank"
          rel="noopener noreferrer"
        >
          caoxing9/inkwave-game
        </a>
        {en
          ? '. MIT licensed. Lovbase is the porting platform, not the original author.'
          : '，采用 MIT 许可证。Lovbase 是此版本的移植与构建平台，不代表原游戏作者。'}
      </footer>
    </main>
  )
}
