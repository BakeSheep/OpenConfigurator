import { useCallback, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * Keep task-level tab state in the current route without discarding section or
 * any other query parameters. The default tab has a canonical, parameter-free
 * URL and invalid/deleted tab ids safely fall back to it.
 */
export function useQueryTab<const TabId extends string>(
  validTabs: readonly TabId[],
  defaultTab: TabId,
  parameterName = 'tab',
): readonly [TabId, (tabId: string, options?: { replace?: boolean }) => void] {
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedTab = searchParams.get(parameterName)
  const validTabSignature = validTabs.join('\u0000')
  const requestedTabIsValid = requestedTab !== null
    && validTabs.includes(requestedTab as TabId)
  const activeTab = requestedTabIsValid ? requestedTab as TabId : defaultTab

  // Canonicalize stale deep links (for example a tab left behind when the
  // workspace section changes) while retaining all unrelated query state.
  useEffect(() => {
    if (
      requestedTab === null
      || (requestedTabIsValid && requestedTab !== defaultTab)
    ) return
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      next.delete(parameterName)
      return next
    }, { replace: true })
  }, [defaultTab, parameterName, requestedTab, requestedTabIsValid, setSearchParams])

  const setActiveTab = useCallback((tabId: string, options?: { replace?: boolean }) => {
    const normalizedTab = validTabs.includes(tabId as TabId)
      ? tabId as TabId
      : defaultTab

    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (normalizedTab === defaultTab) next.delete(parameterName)
      else next.set(parameterName, normalizedTab)
      return next
    }, { replace: options?.replace })
  // The signature makes callers free to pass a translated/memoized tab list
  // without recreating this callback solely because the array identity moved.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultTab, parameterName, setSearchParams, validTabSignature])

  return [activeTab, setActiveTab]
}
