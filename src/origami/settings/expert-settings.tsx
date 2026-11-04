import { ExpandMoreRounded } from '@mui/icons-material'
import { type ReactNode, useState } from 'react'
import { useTranslation } from 'react-i18next'

import SettingClash from '@/components/setting/setting-clash'
import SettingSystem from '@/components/setting/setting-system'
import SettingVergeAdvanced from '@/components/setting/setting-verge-advanced'
import SettingVergeBasic from '@/components/setting/setting-verge-basic'

const OPEN_KEY = 'origami.expertSettingsOpen'

type SectionId = 'connection' | 'core' | 'interface' | 'service'

const readOpen = (): SectionId[] => {
  try {
    const value = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

const saveOpen = (ids: SectionId[]) => {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids))
  } catch {
    // Storage can be unavailable; sections then start closed next time.
  }
}

interface SectionProps {
  id: SectionId
  open: boolean
  onToggle: (id: SectionId) => void
  children: ReactNode
}

const Section = ({ id, open, onToggle, children }: SectionProps) => {
  const { t } = useTranslation()
  return (
    <div className={`o-xset__item${open ? ' is-open' : ''}`}>
      <button
        type="button"
        className="o-xset__head"
        aria-expanded={open}
        onClick={() => onToggle(id)}
      >
        <span className="o-xset__text">
          <span className="o-set__title">
            {t(`origami.settings.expertSections.${id}.title`)}
          </span>
          <span className="o-hint">
            {t(`origami.settings.expertSections.${id}.hint`)}
          </span>
        </span>
        <ExpandMoreRounded className="o-xset__chevron" />
      </button>
      {open && <div className="o-xset__body">{children}</div>}
    </div>
  )
}

/**
 * The stock Clash Verge settings, grouped into folding sections under our own ones. Rows that our
 * settings already have (language, theme, autostart, updates, exit, version) are left out.
 */
export const ExpertSettings = ({
  onError,
}: {
  onError: (error: Error) => void
}) => {
  const [open, setOpen] = useState(readOpen)

  const toggle = (id: SectionId) =>
    setOpen((prev) => {
      const next = prev.includes(id)
        ? prev.filter((item) => item !== id)
        : [...prev, id]
      saveOpen(next)
      return next
    })

  const sections: [SectionId, ReactNode][] = [
    [
      'connection',
      <SettingSystem key="connection" onError={onError} embedded />,
    ],
    ['core', <SettingClash key="core" onError={onError} />],
    [
      'interface',
      <SettingVergeBasic key="interface" onError={onError} embedded />,
    ],
    [
      'service',
      <SettingVergeAdvanced key="service" onError={onError} embedded />,
    ],
  ]

  return (
    <section className="o-plate o-xset">
      {sections.map(([id, content]) => (
        <Section key={id} id={id} open={open.includes(id)} onToggle={toggle}>
          {content}
        </Section>
      ))}
    </section>
  )
}
