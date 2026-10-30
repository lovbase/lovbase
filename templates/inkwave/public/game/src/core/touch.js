// Real pointer-owned touch input. Never changes pointer-lock or keyboard state.
import { G } from './ctx.js'
import { getLang } from '../i18n.js'

export class TouchControls {
  constructor(game) {
    this.game = game
    this.input = game.input
    this.pointers = new Map()
    this.coarse = matchMedia('(any-pointer: coarse)')
    this.focused = true
    this.el = document.createElement('div')
    this.el.className = 'iw-touch'
    this.el.hidden = true
    this.el.innerHTML = `
      <div class="iw-touch-look" data-touch="look"></div>
      <div class="iw-touch-stick" data-touch="move"><span>＋</span></div>
      <div class="iw-touch-actions">
        <button data-touch="KeyF" type="button"></button>
        <button data-touch="KeyE" type="button"></button>
        <button data-touch="ShiftLeft" type="button"></button>
        <button data-touch="Space" type="button"></button>
        <button data-touch="fire" type="button"></button>
      </div>
      <div class="iw-touch-tools">
        <button data-touch="map" type="button"></button>
        <button data-touch="pause" type="button"></button>
      </div>`
    this.rotate = document.createElement('div')
    this.rotate.className = 'iw-touch-rotate'
    this.rotate.hidden = true
    this.rotate.innerHTML = `<p>请横屏游玩<br>Rotate your phone to landscape</p>
      <button type="button" class="iwl-btn">全屏 / Fullscreen</button>
      <small>也可直接旋转手机 · You can also rotate manually</small>`
    this.rotate.querySelector('button').onclick = async () => {
      try {
        await document.documentElement.requestFullscreen?.()
      } catch {
        /* iOS: rotate manually */
      }
      try {
        await screen.orientation?.lock?.('landscape')
      } catch {
        /* optional permission */
      }
    }
    document.body.append(this.el, this.rotate)
    this.el.addEventListener('pointerdown', (e) => this.start(e))
    this.el.addEventListener('pointermove', (e) => this.move(e))
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.el.addEventListener(type, (e) => this.release(e.pointerId))
    }
    // Hybrid devices can return to touch after keyboard/gamepad use.
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType === 'touch') {
          this.seenTouch = true
          this.input.lastDevice = 'touch'
          this.update()
        }
      },
      true,
    )
    const suspend = () => {
      this.reset()
      this.input.touch.active = false
      this.game.pause()
      this.update()
    }
    window.addEventListener('blur', () => {
      this.focused = false
      suspend()
    })
    window.addEventListener('focus', () => {
      this.focused = true
      this.update()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) suspend()
      else this.update()
    })
    window.addEventListener('resize', () => {
      this.reset()
      this.update()
    })
    window.addEventListener('orientationchange', suspend)
    this.coarse.addEventListener('change', () => {
      this.reset()
      this.update()
    })
    this.update()
  }

  get available() {
    return (
      (this.coarse.matches || this.seenTouch || navigator.maxTouchPoints > 0) &&
      Math.min(innerWidth, innerHeight) <= 900 &&
      !this.input.locked &&
      !(this.input.pad && this.input.lastDevice === 'pad')
    )
  }

  reset() {
    const held = [...this.pointers.entries()]
    this.pointers.clear()
    for (const [id, p] of held) {
      if (p.el.hasPointerCapture(id)) p.el.releasePointerCapture(id)
      p.el.classList.remove('is-held')
    }
    this.input.clearTouch()
    this.el.classList.remove('is-map')
  }

  update() {
    const { match, menus } = this.game
    const t = this.input.touch
    const landscape = innerWidth > innerHeight
    const round = G.mode === 'match' && match && !match.attract && ['intro', 'playing'].includes(match.state)
    const ready = !!(
      this.available &&
      landscape &&
      this.focused &&
      !document.hidden &&
      round &&
      !this.blocked &&
      !match.paused &&
      !match.netMenu &&
      !menus?.current
    )
    const playable = ready && match.local?.alive && match.state === 'playing'
    if ((!playable && !this.el.hidden) || (!ready && t.active)) this.reset()
    t.active = ready
    this.el.hidden = !ready
    this.el.classList.toggle('is-inactive', !playable)
    this.playable = playable
    this.rotate.hidden = !(this.available && !landscape)
    document.body.classList.toggle('iw-touch-device', !!this.available)
    const lang = getLang()
    if (lang !== this.lang) {
      this.lang = lang
      const labels =
        lang === 'zh'
          ? ['大招', '炸弹', '潜游', '跳跃', '射击 / 拖动', '地图', '暂停']
          : ['Special', 'Bomb', 'Swim', 'Jump', 'Fire / drag', 'Map', 'Pause']
      this.el.querySelectorAll('button').forEach((b, i) => {
        b.textContent = labels[i]
      })
      this.el
        .querySelector('[data-touch="look"]')
        .setAttribute('aria-label', lang === 'zh' ? '拖动瞄准' : 'Drag to aim')
      this.el
        .querySelector('[data-touch="move"]')
        .setAttribute('aria-label', lang === 'zh' ? '移动摇杆' : 'Movement stick')
    }
  }

  start(e) {
    const el = e.target.closest('[data-touch]')
    if (!el || e.pointerType !== 'touch' || !this.input.touch.active) return
    const action = el.dataset.touch
    if (action === 'pause') {
      e.preventDefault()
      this.game.pause()
      return
    }
    if (!this.playable) return
    e.preventDefault()
    G.audio?.init?.()
    this.input.lastDevice = 'touch'
    if (action === 'map') {
      const open = !this.input.touch.keys.has('Tab')
      this.reset()
      if (open) this.input.touch.keys.add('Tab')
      this.el.classList.toggle('is-map', open)
      return
    }
    if (this.input.touch.keys.has('Tab')) return
    // One owner per control, multiple independent controls at once.
    if ([...this.pointers.values()].some((p) => p.action === action)) return
    el.setPointerCapture(e.pointerId)
    this.pointers.set(e.pointerId, { el, action, x: e.clientX, y: e.clientY })
    el.classList.add('is-held')
    if (action === 'fire') this.input.touch.fire = true
    else if (action !== 'move' && action !== 'look') this.input.touch.keys.add(action)
    if (action === 'move') this.move(e)
  }

  move(e) {
    const p = this.pointers.get(e.pointerId)
    if (!p) return
    e.preventDefault()
    const t = this.input.touch
    if (p.action === 'move') {
      const r = p.el.getBoundingClientRect()
      let x = (e.clientX - r.left - r.width / 2) / (r.width * 0.38)
      let y = (e.clientY - r.top - r.height / 2) / (r.height * 0.38)
      const m = Math.hypot(x, y)
      const scale = m > 0.12 ? Math.min(1, (m - 0.12) / 0.88) / m : 0
      t.x = x * scale
      t.y = y * scale
    } else if (p.action === 'look' || p.action === 'fire') {
      t.dx += e.clientX - p.x
      t.dy += e.clientY - p.y
    }
    p.x = e.clientX
    p.y = e.clientY
  }

  release(id) {
    const p = this.pointers.get(id)
    if (!p) return
    this.pointers.delete(id)
    p.el.classList.remove('is-held')
    if (p.el.hasPointerCapture(id)) p.el.releasePointerCapture(id)
    if (p.action === 'move') this.input.touch.x = this.input.touch.y = 0
    else if (p.action === 'fire') this.input.touch.fire = false
    else this.input.touch.keys.delete(p.action)
  }
}
