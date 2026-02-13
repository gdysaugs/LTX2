type GuestIntroProps = {
  mode: 'image' | 'video'
  onSignIn: () => void
}

const ASSETS = {
  hero: '/media/melt-banner.png',
  modeReal: '/media/mode-real-v2.jpg',
  modeAnime: '/media/mode-anime-v2.png',
  modeEdit: '/media/mode-edit-v2.png',
  promptTipReal: '/media/prompt-tip-real.jpg',
  promptTipAnime: '/media/prompt-tip-anime.png',
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
          <p>実写AIエンジンで高密度なリアル画像を生成。</p>
          <img className="melt-mode-card__image" src={ASSETS.modeReal} alt="リアル生成の説明画像" loading="lazy" />
        </article>
        <article className="melt-mode-card">
          <h3>アニメ</h3>
          <p>神絵師超えのアニメイラストを瞬時に生成。</p>
          <img className="melt-mode-card__image" src={ASSETS.modeAnime} alt="アニメ生成の説明画像" loading="lazy" />
        </article>
        <article className="melt-mode-card">
          <h3>編集</h3>
          <p>高機能編集で元画像を意図通りに変換。</p>
          <img className="melt-mode-card__image" src={ASSETS.modeEdit} alt="編集機能の説明画像" loading="lazy" />
        </article>
      </section>

      <section className="melt-howto">
        <div className="melt-howto__header">
          <h2>プロンプトのコツ</h2>
          <p>リアルとアニメで書き方を切り替えると、狙った画に近づきます。</p>
        </div>
        <div className="melt-howto__flow">
          <div className="melt-howto__card">
            <p>リアル画像（自然言語）</p>
            <img src={ASSETS.promptTipReal} alt="リアル生成のプロンプト例" loading="lazy" />
            <strong>日本人の女性がカフェでアイスを笑顔で食べる</strong>
            <small>リアル画像は自然言語で記述可能</small>
          </div>
          <div className="melt-howto__card">
            <p>アニメ画像（タグ形式）</p>
            <img src={ASSETS.promptTipAnime} alt="アニメ生成のプロンプト例" loading="lazy" />
            <strong>1girl, masterpiece, best quality, coat, long skirt, @anime</strong>
            <small>アニメ画像はタグ形式がおすすめ（@で絵師スタイル指定可能）</small>
          </div>
        </div>
      </section>

      <section className="melt-voices">
        <div className="melt-howto__header">
          <h2>採用実績 / ユーザーの声</h2>
          <p>実制作・創作活動での活用例</p>
        </div>
        <div className="melt-voices__grid">
          <article className="melt-voice-card">
            <p>
              イラストの資料作成が早くなり、構図検討に使える素材を短時間で作れるようになりました。
            </p>
            <small>28歳 / 女性 / M.K</small>
          </article>
          <article className="melt-voice-card">
            <p>
              二次創作のラフ出しで活用しています。複数案をすぐ比較できるので、制作効率が上がりました。
            </p>
            <small>22歳 / 男性 / R.S</small>
          </article>
          <article className="melt-voice-card">
            <p>
              SNSアイコン作成で使っています。テイスト違いを大量に試せて、イメージに合う案を選びやすいです。
            </p>
            <small>31歳 / 女性 / A.T</small>
          </article>
        </div>
      </section>

      <section className="melt-legal">
        <h2>利用規約</h2>
        <p>
          本サービスの利用者は、法令・公序良俗に反する目的で本サービスを利用してはなりません。
          他者の権利を侵害する利用、誹謗中傷、差別、暴力・違法行為を助長する内容の生成を禁止します。
        </p>
        <p>
          未成年者の利用は、親権者等の同意を得たうえで行ってください。未成年者に不適切な内容の生成・閲覧は禁じます。
        </p>
        <p>
          実在人物の顔写真・肖像を無断でアップロードし、なりすまし・性的表現・名誉毀損等に利用する行為を禁止します。
        </p>
        <p>
          生成コンテンツの利用責任は利用者に帰属します。運営は、利用者の入力内容や生成物に起因する損害について責任を負いません。
          サービス品質の維持・改善のため、予告なく機能・仕様を変更する場合があります。
        </p>
      </section>

      <section className="melt-legal">
        <h2>特定商取引法に基づく表記</h2>
        <p>販売事業者: Melt AI 運営事務局</p>
        <p>連絡先: お問い合わせフォームよりご連絡ください</p>
        <p>販売価格: 各購入ページに記載</p>
        <p>支払方法: クレジットカード決済</p>
        <p>提供時期: 決済完了後、直ちに利用可能</p>
      </section>
    </div>
  )
}
