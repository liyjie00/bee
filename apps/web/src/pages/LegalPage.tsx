import { Link } from 'react-router-dom';
import { BeeMark } from '../components/Logo';
import { useI18n } from '../i18n';

interface Section {
  h: string;
  p: string[];
}
interface Doc {
  title: string;
  updated: string;
  sections: Section[];
}

const UPDATED = { en: 'Last updated: November 2, 2026', zh: '最后更新：2026 年 11 月 2 日' };

const PRIVACY: Record<'en' | 'zh', Doc> = {
  en: {
    title: 'Privacy Policy',
    updated: UPDATED.en,
    sections: [
      {
        h: 'Who we are',
        p: [
          'Bee (bee.zippyzoo.dev) is a document editor run by an individual on their own server. This policy explains what Bee stores about you and why.',
        ],
      },
      {
        h: 'What we collect',
        p: [
          'Account details: your email address, the username you choose, a hash of your password (never the password itself), your avatar and your settings.',
          'If you sign in with Google: your Google account ID, email address, name and profile picture, used only to sign you in and fill in your profile. Bee asks Google for nothing else and never sees your Google password, contacts, Gmail or Drive.',
          'Your content: the documents, folders, whiteboards, comments, version history and files you create or upload, and the sharing settings you choose.',
          'Sign-in sessions: a session cookie, plus the IP address and browser of each session so you can recognise them.',
        ],
      },
      {
        h: 'How it is used',
        p: [
          'Only to run Bee: to sign you in, show your documents to you and the people you share them with, and send the notifications you turn on. There are no ads, no tracking or analytics cookies, and your data is never sold.',
        ],
      },
      {
        h: 'Who else processes it',
        p: [
          'Cloudflare carries traffic to the server. Google handles "Continue with Google". If you connect your own AI account for Ask AI, the text you send and the documents it reads go to that AI provider under their terms. Nothing else is shared, except where the law requires it.',
        ],
      },
      {
        h: 'Where it is kept',
        p: [
          'On the operator\'s server, with daily backups on the operator\'s own storage. Data stays until you delete it or ask for your account to be removed; backups age out within 30 days.',
        ],
      },
      {
        h: 'Your choices',
        p: [
          'You can change your profile and password in Settings and delete your documents at any time. To get a copy of your data or have your account deleted, email contactus@bee.zippyzoo.dev.',
        ],
      },
      {
        h: 'Changes',
        p: ['If this policy changes, the new version is posted on this page with a new date.'],
      },
      { h: 'Contact', p: ['Questions about privacy: contactus@bee.zippyzoo.dev'] },
    ],
  },
  zh: {
    title: '隐私政策',
    updated: UPDATED.zh,
    sections: [
      {
        h: '我们是谁',
        p: ['Bee（bee.zippyzoo.dev）是由个人在自己的服务器上运营的文档编辑器。本政策说明 Bee 保存了你的哪些信息，以及原因。'],
      },
      {
        h: '收集哪些信息',
        p: [
          '账号信息：邮箱、你设置的用户名、密码的哈希值（不保存密码原文）、头像和偏好设置。',
          '使用 Google 登录时：你的 Google 账号编号、邮箱、名字和头像，只用于登录和填写资料。Bee 不向 Google 要任何其他权限，看不到你的 Google 密码、联系人、Gmail 或云端硬盘。',
          '你的内容：你创建或上传的文档、文件夹、白板、评论、版本历史和文件，以及你设置的分享方式。',
          '登录会话：会话 Cookie，以及每个会话的 IP 地址和浏览器信息，方便你辨认。',
        ],
      },
      {
        h: '如何使用',
        p: ['只用于运行 Bee：让你登录，把文档展示给你和你分享的人，发送你开启的通知。没有广告，没有追踪或统计 Cookie，从不出售你的数据。'],
      },
      {
        h: '还有谁会处理',
        p: [
          'Cloudflare 负责把访问转发到服务器；Google 负责「使用 Google 账号继续」；如果你为 Ask AI 连接了自己的 AI 账号，你发出的内容和它读取的文档会发给该 AI 服务商，适用对方的条款。除此之外不与任何人共享，法律要求的情况除外。',
        ],
      },
      {
        h: '存在哪里',
        p: ['存放在运营者的服务器上，每天备份到运营者自己的存储设备。数据会一直保留，直到你删除或要求注销账号；备份最多保留 30 天。'],
      },
      {
        h: '你的权利',
        p: ['你可以随时在设置中修改资料和密码、删除自己的文档。如需导出数据或注销账号，请发邮件到 contactus@bee.zippyzoo.dev。'],
      },
      {
        h: '政策变更',
        p: ['本政策如有变化，新版本会发布在此页面并更新日期。'],
      },
      { h: '联系我们', p: ['隐私相关问题请发邮件到 contactus@bee.zippyzoo.dev'] },
    ],
  },
};

const TERMS: Record<'en' | 'zh', Doc> = {
  en: {
    title: 'Terms of Service',
    updated: UPDATED.en,
    sections: [
      {
        h: 'Using Bee',
        p: [
          'Bee is offered free of charge by an individual, as is, without any warranty. By using it you agree to these terms and to the Privacy Policy.',
        ],
      },
      {
        h: 'Your account',
        p: ['Keep your password safe; you are responsible for what happens in your account. One person per account.'],
      },
      {
        h: 'Your content',
        p: [
          'What you write stays yours. You give Bee only the permission it needs to store your content and show it to you and the people you share it with.',
          'Do not use Bee for anything illegal, to harm others, to spread malware or spam, or to infringe others\' rights. Content that breaks these rules may be removed.',
        ],
      },
      {
        h: 'Availability',
        p: [
          'Bee runs on a single server and may be unavailable, change, or shut down. Keep your own copies of anything important (Bee can export documents). The operator is not liable for lost data or other damages, to the extent the law allows.',
        ],
      },
      {
        h: 'Ending',
        p: [
          'You can stop using Bee at any time. Accounts that break these terms may be suspended. These terms may change; continuing to use Bee after a change means you accept it.',
        ],
      },
      { h: 'Contact', p: ['contactus@bee.zippyzoo.dev'] },
    ],
  },
  zh: {
    title: '服务条款',
    updated: UPDATED.zh,
    sections: [
      {
        h: '使用 Bee',
        p: ['Bee 由个人免费提供，按现状提供，不作任何保证。使用 Bee 即表示你同意本条款和隐私政策。'],
      },
      {
        h: '你的账号',
        p: ['请保管好密码，你需要对账号内发生的事情负责。一人一个账号。'],
      },
      {
        h: '你的内容',
        p: [
          '你写的内容归你所有。你只授予 Bee 保存这些内容、并展示给你和你分享的人所需的权限。',
          '不得用 Bee 从事违法活动、伤害他人、传播恶意软件或垃圾信息，或侵犯他人权利。违反的内容可能被删除。',
        ],
      },
      {
        h: '服务可用性',
        p: ['Bee 运行在一台服务器上，可能会中断、变化或停止服务。重要内容请自行保留副本（Bee 支持导出文档）。在法律允许的范围内，运营者不对数据丢失或其他损失负责。'],
      },
      {
        h: '终止',
        p: ['你可以随时停止使用 Bee。违反本条款的账号可能被停用。本条款可能更新，更新后继续使用即表示接受。'],
      },
      { h: '联系我们', p: ['contactus@bee.zippyzoo.dev'] },
    ],
  },
};

/** Public privacy policy and terms pages (linked from Google's sign-in consent screen). */
export function LegalPage({ kind }: { kind: 'privacy' | 'terms' }) {
  const { lang } = useI18n();
  const doc = (kind === 'privacy' ? PRIVACY : TERMS)[lang === 'zh-CN' ? 'zh' : 'en'];
  const other = kind === 'privacy' ? TERMS : PRIVACY;
  return (
    <div className="public">
      <header>
        <BeeMark size={22} />
        <b>bee</b>
        <Link to="/login" style={{ marginLeft: 'auto', color: 'var(--honey-ink)' }}>
          {lang === 'zh-CN' ? '登录' : 'Sign in'}
        </Link>
      </header>
      <article className="legal prose">
        <h1>{doc.title}</h1>
        <p className="legal-updated">{doc.updated}</p>
        {doc.sections.map((s) => (
          <section key={s.h}>
            <h2>{s.h}</h2>
            {s.p.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </section>
        ))}
        <p>
          <Link to={kind === 'privacy' ? '/terms' : '/privacy'}>{other[lang === 'zh-CN' ? 'zh' : 'en'].title}</Link>
        </p>
      </article>
    </div>
  );
}
