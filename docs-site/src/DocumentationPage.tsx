import { useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSlug from 'rehype-slug'
import remarkGfm from 'remark-gfm'
import {
  DOCUMENTATION,
  DOCUMENTATION_ID_BY_SOURCE,
  documentationUrl,
  type DocumentationEntry,
} from './docs'

const owner = import.meta.env.VITE_GITHUB_OWNER || 'dstours'
const repo = import.meta.env.VITE_GITHUB_REPO || 'OctoC2'
const repositoryUrl = `https://github.com/${owner}/${repo}`
const logoUrl = `${import.meta.env.BASE_URL}logo.png`

function normalizePath(path: string): string {
  const output: string[] = []
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') output.pop()
    else output.push(part)
  }
  return output.join('/')
}

function resolveArticleLink(
  current: DocumentationEntry,
  href: string,
): { href: string; external: boolean } {
  if (!href || href.startsWith('#')) return { href, external: false }
  if (/^(https?:|mailto:)/i.test(href)) return { href, external: true }

  const hashAt = href.indexOf('#')
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href
  const anchor = hashAt >= 0 ? href.slice(hashAt) : ''
  const directory = current.sourcePath.split('/').slice(0, -1).join('/')
  const sourcePath = normalizePath(`${directory}/${path}`)
  const articleId = DOCUMENTATION_ID_BY_SOURCE.get(sourcePath)

  if (articleId) return { href: documentationUrl(articleId, anchor), external: false }
  return {
    href: `${repositoryUrl}/blob/main/${sourcePath}${anchor}`,
    external: true,
  }
}

function plainHeading(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim()
}

function headingSlug(markdown: string): string {
  return plainHeading(markdown)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function tableOfContents(content: string) {
  return content
    .split('\n')
    .flatMap((line) => {
      const match = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
      if (!match?.[1] || !match[2]) return []
      const title = plainHeading(match[2])
      return [{ level: match[1].length, title, id: headingSlug(match[2]) }]
    })
}

function DocumentationHeader() {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href={import.meta.env.BASE_URL} aria-label="OctoC2 documentation home">
          <img src={logoUrl} alt="" />
          <span>OctoC2</span>
          <span className="brand-divider" />
          <span className="brand-context">Docs</span>
        </a>
        <nav className="topnav docs-topnav" aria-label="Documentation navigation">
          <a href={import.meta.env.BASE_URL}>Overview</a>
          <a href={documentationUrl('documentation')}>All guides</a>
        </nav>
        <a className="repo-link" href={repositoryUrl}>GitHub <span aria-hidden="true">↗</span></a>
      </div>
    </header>
  )
}

function GuideNavigation({ currentId }: { currentId: string }) {
  const categories = ['Start', 'Operate', 'Resilience', 'Engineering'] as const
  return (
    <nav className="docs-sidebar" aria-label="Documentation guides">
      <a className="docs-overview-link" href={import.meta.env.BASE_URL}>← Documentation home</a>
      <div className="docs-nav-links">
        {categories.map((category) => (
          <section key={category}>
            <h2>{category}</h2>
            {DOCUMENTATION.filter((entry) => entry.category === category).map((entry) => (
              <a
                className={entry.id === currentId ? 'active' : undefined}
                href={documentationUrl(entry.id)}
                key={entry.id}
                aria-current={entry.id === currentId ? 'page' : undefined}
              >
                {entry.title}
              </a>
            ))}
          </section>
        ))}
      </div>
    </nav>
  )
}

function ArticleTableOfContents({ content }: { content: string }) {
  const headings = tableOfContents(content)
  return (
    <aside className="docs-toc" aria-label="On this page">
      <strong>On this page</strong>
      {headings.map((heading) => (
        <a className={heading.level === 3 ? 'nested' : undefined} href={`#${heading.id}`} key={`${heading.level}-${heading.id}`}>
          {heading.title}
        </a>
      ))}
    </aside>
  )
}

export function DocumentationPage({ entry }: { entry: DocumentationEntry }) {
  const [content, setContent] = useState('')
  const [loadError, setLoadError] = useState(false)

  useEffect(() => {
    document.title = `${entry.title} — OctoC2 Documentation`
    let active = true
    entry.load()
      .then((markdown) => {
        if (active) setContent(markdown)
      })
      .catch(() => {
        if (active) setLoadError(true)
      })
    return () => { active = false }
  }, [entry])

  const components: Components = {
    a({ href = '', children }: { href?: string; children?: ReactNode }) {
      const resolved = resolveArticleLink(entry, href)
      return (
        <a
          href={resolved.href}
          {...(resolved.external && { target: '_blank', rel: 'noreferrer' })}
        >
          {children}
        </a>
      )
    },
  }
  const renderedContent = content.replace(/^> \[!IMPORTANT\]\r?\n/gm, '')

  return (
    <div className="site-shell docs-reader">
      <DocumentationHeader />
      <aside className="notice" role="note">
        <div>
          <span className="notice-mark" aria-hidden="true">i</span>
          <p><strong>Authorized use only.</strong> Run OctoC2 only on systems and repositories you own or have explicit permission to test.</p>
        </div>
      </aside>
      <main className="docs-layout">
        <GuideNavigation currentId={entry.id} />
        <article className="docs-article">
          <div className="docs-article-meta">
            <span>{entry.category}</span>
            <a href={`${repositoryUrl}/blob/main/${entry.sourcePath}`} target="_blank" rel="noreferrer">View source ↗</a>
          </div>
          {loadError ? (
            <p className="docs-load-error">This guide could not be loaded. Return to the documentation index and try again.</p>
          ) : content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSlug]} components={components}>
              {renderedContent}
            </ReactMarkdown>
          ) : (
            <div className="docs-loading" role="status">Loading guide…</div>
          )}
        </article>
        <ArticleTableOfContents content={content} />
      </main>
    </div>
  )
}
