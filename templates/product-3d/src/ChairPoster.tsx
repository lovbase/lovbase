export function ChairPoster({
  seat = '#d8cdb8',
  frame = '#b88b58',
  label = 'Arc chair',
}: {
  seat?: string
  frame?: string
  label?: string
}) {
  return (
    // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- Inline SVG supports the selected material colors.
    <svg viewBox="0 0 600 580" role="img" aria-label={label} className="studio-poster">
      <ellipse cx="307" cy="472" rx="147" ry="25" fill="#333" opacity=".08" />
      <g fill={frame} stroke="#000" strokeOpacity=".1" strokeWidth="2">
        <path d="M236 296l-13 165-15 5 4-166z" />
        <path d="M389 286l33 164-15 10-42-165z" />
        <path d="M230 172l18 270-17 6-23-268z" />
        <path d="M374 176l-20 273-18-3 13-273z" />
        <path d="M212 315l163-18 30 18-164 45-29-13z" />
      </g>
      <path
        d="M202 154 Q280 116 371 151 Q395 158 390 186 L382 232 Q288 261 211 222 Q202 211 202 154"
        fill={frame}
      />
      <path
        d="M204 165 Q284 134 375 165 L370 225 Q291 249 214 219 Q204 212 204 165"
        fill={seat}
        stroke="#fff"
        strokeOpacity=".35"
        strokeWidth="3"
      />
      <path
        d="M213 288 Q287 263 365 286 L406 320 Q410 336 392 344 L262 377 Q248 382 233 371 L193 337 Q180 322 190 306z"
        fill={seat}
      />
      <path
        d="M193 329l49 39q10 10 28 4l130-35"
        fill="none"
        stroke="#000"
        strokeOpacity=".1"
        strokeWidth="9"
      />
      <path d="M246 367l-15 117 19-1 21-113zM387 343l28 124 18-7-22-124z" fill={frame} />
    </svg>
  )
}
