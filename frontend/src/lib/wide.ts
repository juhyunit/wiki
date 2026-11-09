import { useState } from 'react'
import { storage } from './util'

// 읽기·편집 화면 넓게 보기(목차 숨김). 이 브라우저에만 기억한다
export function useWideView(): [boolean, () => void] {
  const [wide, setWide] = useState(() => storage.get('ww:wide') === '1')
  const toggle = () =>
    setWide((w) => {
      storage.set('ww:wide', w ? '0' : '1')
      return !w
    })
  return [wide, toggle]
}
