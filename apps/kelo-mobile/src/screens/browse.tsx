import type { KeloCategory, KeloListingSummary, List } from '@aora/api-client';
import {
  Button,
  Choice,
  exponentOf,
  ListItem,
  money,
  Muted,
  ResourceView,
  Screen,
  TextField,
  useAssets,
  useResource,
  useServices,
} from '@aora/mobile';
import { useState } from 'react';
import { t } from '../messages';

/** The marketplace: search, a category, and published listings only. */
export function BrowseScreen({ go }: { go: (path: string) => void }): React.JSX.Element {
  const { signOut } = useServices();
  const [text, setText] = useState('');
  const [search, setSearch] = useState({ q: '', category: '' });
  const assets = useAssets();
  const categories = useResource('kelo.categories', (api) =>
    api.get<List<KeloCategory>>('/v1/kelo/categories'),
  );
  const listings = useResource(`kelo.listings:${search.q}:${search.category}`, (api) =>
    api.get<List<KeloListingSummary>>('/v1/kelo/marketplace/listings', {
      q: search.q,
      category: search.category,
      limit: 20,
    }),
  );
  return (
    <Screen title={t('browse.title')}>
      <ListItem
        title={t('nav.purchases')}
        onPress={() => {
          go('/purchases');
        }}
      />
      <TextField
        label={t('browse.search_label')}
        value={text}
        onChangeText={setText}
        maxLength={100}
      />
      <Button
        label={t('browse.search_button')}
        onPress={() => {
          setSearch({ ...search, q: text.trim() });
        }}
      />
      <ResourceView resource={categories}>
        {(list) => (
          <>
            <Muted>{t('browse.category')}</Muted>
            <Choice
              label={t('browse.all_categories')}
              selected={search.category === ''}
              onSelect={() => {
                setSearch({ ...search, category: '' });
              }}
            />
            {list.data.map((category) => (
              <Choice
                key={category.slug}
                label={category.name}
                selected={search.category === category.slug}
                onSelect={() => {
                  setSearch({ ...search, category: category.slug });
                }}
              />
            ))}
          </>
        )}
      </ResourceView>
      <ResourceView resource={assets}>
        {(assetList) => (
          <ResourceView resource={listings}>
            {(list) =>
              list.data.length === 0 ? (
                <Muted>{t('browse.empty')}</Muted>
              ) : (
                list.data.map((listing) => (
                  <ListItem
                    key={listing.id}
                    title={listing.title}
                    detail={[
                      listing.from_price_minor === null
                        ? t('listing.by_quote')
                        : t('listing.from', {
                            amount: money(
                              listing.from_price_minor,
                              listing.currency,
                              exponentOf(assetList, listing.currency),
                            ),
                          }),
                      t('listing.sold_by', { store: listing.store_name }),
                    ].join(' · ')}
                    onPress={() => {
                      go(`/l/${listing.id}`);
                    }}
                  />
                ))
              )
            }
          </ResourceView>
        )}
      </ResourceView>
      <Button
        label={t('nav.security')}
        onPress={() => {
          go('/security');
        }}
        secondary
      />
      <Button label={t('nav.sign_out')} onPress={() => void signOut()} secondary />
    </Screen>
  );
}
