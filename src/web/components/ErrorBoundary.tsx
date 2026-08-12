import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { Button } from './ui/Button'
import StatePanel from './ui/StatePanel'

interface ErrorBoundaryProps extends PropsWithChildren {
  fallback: (retry: () => void) => ReactNode
  resetKey: string
}

interface ErrorBoundaryState {
  hasError: boolean
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[UI] Workspace render failed:', error, info.componentStack)
  }

  componentDidUpdate(previousProps: ErrorBoundaryProps) {
    if (this.state.hasError && previousProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false })
    }
  }

  private retry = () => {
    this.setState({ hasError: false })
  }

  render() {
    if (this.state.hasError) return this.props.fallback(this.retry)
    return this.props.children
  }
}

export default function WorkspaceErrorBoundary({ children }: PropsWithChildren) {
  const { t } = useTranslation()
  const location = useLocation()

  return (
    <ErrorBoundary
      resetKey={`${location.pathname}${location.search}`}
      fallback={(retry) => (
        <StatePanel
          kind="error"
          headingLevel={1}
          title={t('app.workspaceErrorTitle')}
          description={t('app.workspaceErrorDescription')}
          action={(
            <div className="flex items-center justify-center gap-2">
              <Button tone="primary" onClick={retry} autoFocus>
                {t('common.retry')}
              </Button>
              <Button tone="secondary" onClick={() => window.location.reload()}>
                {t('app.reloadPage')}
              </Button>
            </div>
          )}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
