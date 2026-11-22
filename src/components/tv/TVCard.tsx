'use client';

import { Ban, Play, Star } from 'lucide-react';
import { useRouter } from 'next/navigation';

import { processImageUrl } from '@/lib/utils';

import { TVItem } from './types';

export default function TVCard({ item }: { item: TVItem }) {
  const router = useRouter();
  const poster = item.poster ? processImageUrl(item.poster) : '';
  const playUrl = item.href || `/tv/detail?title=${encodeURIComponent(item.title)}${
    item.year ? `&year=${encodeURIComponent(item.year)}` : ''
  }${item.type ? `&stype=${item.type}` : ''}`;

  return (
    <button
      type='button'
      disabled={item.isInvalid}
      aria-label={item.isInvalid ? `${item.title}，已失效` : item.title}
      onClick={() => {
        if (!item.isInvalid) router.push(playUrl);
      }}
      className={`group w-[210px] shrink-0 rounded-[28px] bg-white/[0.04] p-3 text-left outline-none transition duration-200 tv-focusable ${
        item.isInvalid
          ? 'cursor-not-allowed'
          : 'cursor-pointer hover:bg-white/10 focus-visible:bg-white/10'
      }`}
    >
      <div className='relative aspect-[2/3] overflow-hidden rounded-[22px] bg-slate-900 shadow-xl shadow-black/50 transition duration-200 group-hover:scale-[1.03] group-focus-visible:scale-[1.03]'>
        {poster ? (
          <img src={poster} alt={item.title} className='h-full w-full object-cover' />
        ) : (
          <div className='flex h-full w-full items-center justify-center bg-gradient-to-br from-slate-800 to-slate-950 text-slate-500'>
            {!item.isInvalid && <Play className='h-14 w-14' />}
          </div>
        )}
        {item.isInvalid && (
          <div className='pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 text-white'>
            <Ban className='h-12 w-12' strokeWidth={1.5} aria-hidden='true' />
            <span className='text-lg font-medium'>已失效</span>
          </div>
        )}
        <div className='absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent p-3'>
          <div className='inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-1 text-sm text-amber-300 backdrop-blur'>
            <Star className='h-4 w-4 fill-current' />
            {item.rate || '推荐'}
          </div>
        </div>
      </div>
      <h3 className='mt-3 line-clamp-1 text-[22px] font-bold text-white'>{item.title}</h3>
      <p className='mt-1 text-lg text-slate-400'>{item.year || '即刻播放'}</p>
    </button>
  );
}
