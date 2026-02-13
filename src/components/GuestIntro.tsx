type GuestIntroProps = {
  mode: 'image' | 'video'
  onSignIn: () => void
}

const ASSETS = {
  hero: '/media/melt-banner.png',
  howToSource1: '/media/howto-source-1.jpg',
  howToResult1: '/media/howto-result-1.mp4',
  howToSource2: '/media/howto-source-2.jpg',
  howToResult2: '/media/howto-result-2.png',
}

export function GuestIntro({ mode: _mode, onSignIn }: GuestIntroProps) {
  return (
    <div className="melt-landing">
      <section className="melt-hero">
        <div className="melt-hero__copy">
          <p className="melt-hero__kicker">Melt AI</p>
          <h1>生成AIスタジオ</h1>
          <p className="melt-hero__lead">
            リアル生成、アニメ生成、画像編集を1つのUIで完結。
            <br />
            プロンプトを入力して、すぐに結果を確認できます。
          </p>
          <div className="melt-hero__stats">
            <span>全世界ユーザー 50,000+</span>
            <span>今すぐ登録で5回無料</span>
            <span>高速生成エンジン</span>
            <span>神絵師イラストを誰でも</span>
            <span>絵師スタイル自由自在</span>
            <span>超リアルな実写生成</span>
          </div>
          <div className="melt-hero__actions">
            <button type="button" className="primary-button primary-button--pulse" onClick={onSignIn}>
              登録 / ログイン
            </button>
          </div>
        </div>
        <div className="melt-hero__media">
          <img src={ASSETS.hero} alt="Melt AI ヒーロー画像" loading="eager" />
        </div>
      </section>

      <section className="melt-modes">
        <article className="melt-mode-card">
          <h3>リアル</h3>
          <p>zimage で高密度なリアル画像を生成。</p>
        </article>
        <article className="melt-mode-card">
          <h3>アニメ</h3>
          <p>anima でスタイル重視のアニメイラストを生成。</p>
        </article>
        <article className="melt-mode-card">
          <h3>編集</h3>
          <p>Qwen Image Edit で元画像を意図通りに変換。</p>
        </article>
      </section>

      <section className="melt-howto">
        <div className="melt-howto__header">
          <h2>使い方（例）</h2>
          <p>画像とプロンプトだけで、編集結果をすぐプレビュー。</p>
        </div>
        <div className="melt-howto__flow">
          <div className="melt-howto__card">
            <p>元画像</p>
            <img src={ASSETS.howToSource2} alt="元画像サンプル" loading="lazy" />
          </div>
          <div className="melt-howto__card melt-howto__card--prompt">
            <p>プロンプト</p>
            <strong>帽子をかぶって金髪にして</strong>
            <small>ネガティブも同画面で入力</small>
          </div>
          <div className="melt-howto__card">
            <p>生成結果</p>
            <img src={ASSETS.howToResult2} alt="生成結果サンプル" loading="lazy" />
          </div>
        </div>
      </section>

      <section className="melt-howto">
        <div className="melt-howto__header">
          <h2>動画生成（例）</h2>
          <p>静止画をアップロードして短尺動画へ。</p>
        </div>
        <div className="melt-howto__flow">
          <div className="melt-howto__card">
            <p>元画像</p>
            <img src={ASSETS.howToSource1} alt="動画元画像サンプル" loading="lazy" />
          </div>
          <div className="melt-howto__card melt-howto__card--prompt">
            <p>プロンプト</p>
            <strong>女性が笑顔で手を振る</strong>
            <small>アニメタブ / 動画モードで生成</small>
          </div>
          <div className="melt-howto__card">
            <p>生成結果</p>
            <video src={ASSETS.howToResult1} autoPlay loop muted playsInline preload="metadata" />
          </div>
        </div>
      </section>
    </div>
  )
}
