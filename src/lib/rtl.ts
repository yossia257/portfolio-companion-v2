export function getDirection(language: string): 'rtl' | 'ltr' {
  return ['he', 'ar', 'fa', 'ur'].includes(language) ? 'rtl' : 'ltr'
}

export function getTextAlign(language: string): 'right' | 'left' {
  return getDirection(language) === 'rtl' ? 'right' : 'left'
}
