'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { GuomanItem } from '@/lib/types';

interface GuomanCardProps {
  item: GuomanItem;
}

export default function GuomanCard({ item }: GuomanCardProps) {
  const [imageSrc, setImageSrc] = useState(item.poster || item.cover);

  const meta = [
    `${item.weekdayLabel}${item.pubTime ? ` ${item.pubTime}` : ''} 更新`,
    item.latest,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Link
      href={`/search?q=${encodeURIComponent(item.title)}`}
      className='group block w-full'
    >
      <div className='relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-200 dark:bg-gray-700'>
        {imageSrc ? (
          <img
            src={imageSrc}
            alt={item.title}
            loading='lazy'
            referrerPolicy='no-referrer'
            className='h-full w-full object-cover transition-transform duration-300 group-hover:scale-105'
            onError={() => {
              if (item.cover && imageSrc !== item.cover) {
                setImageSrc(item.cover);
              }
            }}
          />
        ) : (
          <div className='flex h-full w-full items-center justify-center bg-gradient-to-br from-gray-300 to-gray-400 p-2 text-center text-sm text-white dark:from-gray-600 dark:to-gray-700'>
            {item.title}
          </div>
        )}

        <div className='absolute left-1.5 top-1.5 rounded bg-black/65 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm'>
          {item.platform}
        </div>

        {item.latest && (
          <div className='absolute right-1.5 top-1.5 rounded bg-pink-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm'>
            {item.latest}
          </div>
        )}
      </div>

      <div className='mt-2 line-clamp-2 text-sm font-medium text-gray-800 transition-colors group-hover:text-green-600 dark:text-gray-200 dark:group-hover:text-green-400'>
        {item.title}
      </div>
      <div className='mt-0.5 line-clamp-1 text-xs text-gray-500 dark:text-gray-400'>
        {meta}
      </div>
    </Link>
  );
}
